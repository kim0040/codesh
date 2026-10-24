#!/usr/bin/env bash
# Tests deploy/update.sh against a fake release server and a fake docker:
#   scripts/box 'bash deploy/update.test.sh'
# Covers --check, refused major and downgrade, checksum and digest mismatches, the happy path,
# rollback after a failed health check, --auto with its policy, and the timer (systemd, cron, dry run).
# Needs python3 (the HTTP server) and curl.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
F="$(mktemp -d)"
server=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null
  rm -rf "$F"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  [ -f "$F/run.log" ] && tail -20 "$F/run.log" >&2
  exit 1
}

mkdir -p "$F/bin" "$F/srv/api/repos/kim0040/codesh" "$F/install" "$F/systemd"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
base="http://127.0.0.1:$port"

# --- fake docker: logs every call; compose reads CODESH_VERSION from ./.env like the real one ----
cat >"$F/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
version() { sed -n 's/^CODESH_VERSION=//p' .env | tail -n 1; }
registry() { r="$(sed -n 's/^CODESH_REGISTRY=//p' .env | tail -n 1)"; printf '%s' "${r:-ghcr.io/kim0040}"; }
if [ "$1" = compose ]; then
  shift
  case "$1" in
    version) exit 0 ;;
    config) for n in web api collab; do printf '%s/codesh-%s:%s\n' "$(registry)" "$n" "$(version)"; done ;;
    pull) [ -n "${FAKE_PULL_FAIL:-}" ] && exit 1; exit 0 ;;
    up) [ "$(version)" = "${FAKE_UNHEALTHY:-none}" ] && { echo "container api is unhealthy" >&2; exit 1; }; exit 0 ;;
    exec) case "${!#}" in dump) printf 'fake-dump\n' ;; restore) cat >/dev/null; echo restored >>"$DOCKER_CALLS" ;; esac ;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  ref="${!#}"
  name="${ref%:*}"
  printf '%s@sha256:%s\n' "$name" "$(printf '%s' "${name##*/}${FAKE_DIGEST_SALT:-}" | sha256sum | cut -c1-64)"
  exit 0
fi
exit 0
DOCKER
cat >"$F/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$DOCKER_CALLS"
SYSTEMCTL
cat >"$F/bin/crontab" <<'CRONTAB'
#!/usr/bin/env bash
# Like crontab(1): reads the whole new table before replacing the old one.
if [ "${1:-}" = -l ]; then cat "$CRONTAB_FILE" 2>/dev/null || exit 1; else cat >"$CRONTAB_FILE.new" && mv "$CRONTAB_FILE.new" "$CRONTAB_FILE"; fi
CRONTAB
chmod +x "$F/bin"/*
export PATH="$F/bin:$PATH" DOCKER_CALLS="$F/docker.calls" CRONTAB_FILE="$F/crontab"
export UPDATE_API_URL="$base/api" UPDATE_DOWNLOAD_URL="$base/dl" UPDATE_HEALTH_TIMEOUT=3
digest() { printf '%s' "$1" | sha256sum | cut -c1-64; }

# --- releases: deploy archives laid out as release.yml publishes them ----------------------------
# release <version> [bad-checksum|bad-digest]
release() {
  local v="$1" dir="$F/srv/dl/kim0040/codesh/releases/download/v$1" stage="$F/stage/codesh-$1"
  mkdir -p "$dir" "$stage/docs" "$stage/tls" "$stage/state"
  cp "$root"/deploy/{lib.sh,generate-secrets.sh,install.sh,upgrade.sh,update.sh,backup.sh,restore.sh,docker-compose.yml} "$stage/"
  printf '# release %s\n' "$v" >>"$stage/update.sh"
  sed "s/^CODESH_VERSION=.*/CODESH_VERSION=$v/" "$root/deploy/.env.example" >"$stage/.env.example"
  printf 'NEW_IN_%s=yes\n' "${v//./_}" >>"$stage/.env.example"
  printf '%s\n' "$v" >"$stage/VERSION"
  for n in web api collab mdns; do
    if [ "${2:-}" = bad-digest ]; then printf 'codesh-%s sha256:%s\n' "$n" "$(digest "other-$n")"
    else printf 'codesh-%s sha256:%s\n' "$n" "$(digest "codesh-$n")"; fi
  done >"$stage/IMAGES"
  (cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS)
  tar czf "$dir/codesh-deploy-$v.tar.gz" -C "$F/stage" "codesh-$v"
  (cd "$dir" && sha256sum "codesh-deploy-$v.tar.gz" >SHA256SUMS)
  if [ "${2:-}" = bad-checksum ]; then
    sed -i "s/^[0-9a-f]\{64\}/$(digest tampered)/" "$dir/SHA256SUMS"
  fi
}
release 1.0.1
release 1.0.2 bad-checksum
release 1.0.3 bad-digest
release 1.0.4
release 1.0.5
release 1.1.0
release 2.0.0
releases_json() {
  printf '['
  local first=1 v
  for v in "$@"; do
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"tag_name":"v%s","name":"codesh %s","draft":false,"prerelease":%s,"body":"has \\"tag_name\\": \\"v9.9.9\\" inside"}' \
      "$v" "$v" "$([[ "$v" == *-* ]] && echo true || echo false)"
  done
  printf ']'
}
releases_json 2.0.0 1.2.0-rc.1 1.1.0 1.0.5 1.0.4 1.0.3 1.0.2 1.0.1 1.0.0 >"$F/srv/api/repos/kim0040/codesh/releases"
touch "$F/srv/healthz" "$F/srv/readyz"
python3 -m http.server --bind 127.0.0.1 --directory "$F/srv" "$port" >/dev/null 2>&1 &
server=$!
for _ in $(seq 50); do curl -fs "$base/healthz" >/dev/null 2>&1 && break; sleep 0.1; done

# --- an installation of 1.0.0 --------------------------------------------------------------------
I="$F/install"
cp "$root"/deploy/{lib.sh,generate-secrets.sh,install.sh,upgrade.sh,update.sh,backup.sh,restore.sh,docker-compose.yml,.env.example} "$I/"
sed -e 's/^CODESH_VERSION=.*/CODESH_VERSION=1.0.0/' -e "s/^HTTP_PORT=.*/HTTP_PORT=$port/" "$I/.env.example" >"$I/.env"
(cd "$I" && ./generate-secrets.sh .env >/dev/null)
envv() { sed -n "s/^$1=//p" "$I/.env" | tail -n 1; }
status() { cat "$I/state/update.json"; }
run() { (cd "$I" && "$@") >"$F/run.log" 2>&1; }
calls() { cat "$DOCKER_CALLS" 2>/dev/null || true; }

step "--check: newest of this major and the new major, nothing changes"
run ./update.sh --check || fail "--check failed"
grep -q 'installed 1.0.0, newest 2.0.0' "$F/run.log" || fail "--check did not name 2.0.0"
grep -q 'update with ./update.sh (to 1.1.0) or ./update.sh --allow-major (to 2.0.0)' "$F/run.log" || fail "--check advice"
grep -q 9.9.9 "$F/run.log" && fail "read a tag from inside a release body"
[ -f "$I/state/update.json" ] && fail "--check wrote a status"
[ "$(envv CODESH_VERSION)" = 1.0.0 ] || fail "version changed"
ok "--check: 1.1.0 within 1.x, 2.0.0 needs --allow-major; pre-release 1.2.0-rc.1 not offered"

step "a major version is refused"
if run ./update.sh --version 2.0.0 --yes; then fail "major update accepted"; else [ $? = 3 ] || fail "exit code"; fi
grep -q 'new major version' "$F/run.log" || fail "major refusal message"
status | grep -q '"result":"refused"' || fail "refusal not recorded"
calls | grep -q '^compose pull' && fail "pulled during a refusal"
ok "2.0.0 refused without --allow-major, recorded"

step "checksum mismatch: refused before backup or pull"
: >"$DOCKER_CALLS"
run ./update.sh --version 1.0.2 --yes && fail "accepted a tampered archive"
grep -q 'checksum mismatch: codesh-deploy-1.0.2.tar.gz' "$F/run.log" || fail "wrong refusal"
calls | grep -q 'exec -T mongo' && fail "backup ran"
calls | grep -q '^compose pull' && fail "pulled"
[ "$(envv CODESH_VERSION)" = 1.0.0 ] || fail "version changed"
status | grep -q '"result":"failed","from":"1.0.0","to":"1.0.2"' || fail "failure not recorded"
ok "1.0.2 with a wrong checksum refused; no backup, no pull, .env unchanged"

step "happy path 1.0.0 -> 1.0.1"
: >"$DOCKER_CALLS"
run ./update.sh --version 1.0.1 --yes || fail "update failed"
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "CODESH_VERSION not 1.0.1"
[ "$(envv NEW_IN_1_0_1)" = yes ] || fail "new setting not added"
[ "$(cat "$I/VERSION")" = 1.0.1 ] || fail "files not installed"
tail -n 1 "$I/update.sh" | grep -q '^# release 1.0.1' || fail "update.sh not replaced"
grep -q 'exec -T mongo' "$DOCKER_CALLS" || fail "no backup"
ls "$I"/backups/codesh-*.archive.gz >/dev/null || fail "no backup file"
grep -q '^compose pull' "$DOCKER_CALLS" || fail "no pull"
grep -q '^compose up -d --wait' "$DOCKER_CALLS" || fail "no up"
status | grep -q '"result":"updated","from":"1.0.0","to":"1.0.1"' || fail "status not updated"
[ "$(stat -c %a "$I/state/update.json")" = 644 ] || fail "update.json is not readable by the api container"
[ "$(stat -c %a "$I/state/update.log")" = 600 ] || fail "update.log is not private"
grep -q 'updating 1.0.0 -> 1.0.1' "$I/state/update.log" || fail "not logged"
ok "1.0.1 installed: files, setting, backup, pull, up, status, log"

step "a downgrade is refused"
run ./update.sh --version 1.0.0 --yes && fail "downgrade accepted"
grep -q 'older than 1.0.1' "$F/run.log" || fail "downgrade message"
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "version changed"
ok "1.0.0 refused on 1.0.1"

step "pulled images with other digests: nothing restarts, files go back"
: >"$DOCKER_CALLS"
run ./update.sh --version 1.0.3 --yes && fail "accepted wrong image digests"
grep -q 'is not the released image' "$F/run.log" || fail "digest message"
grep -q '^compose up' "$DOCKER_CALLS" && fail "restarted with unverified images"
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "version not put back"
[ "$(cat "$I/VERSION")" = 1.0.1 ] || fail "files not put back"
ok "1.0.3 refused after pull; 1.0.1 files and version back, no restart"

step "health check fails: rollback to the previous version and the backup"
: >"$DOCKER_CALLS"
if FAKE_UNHEALTHY=1.0.4 run ./update.sh --version 1.0.4 --yes; then fail "unhealthy update reported success"; fi
grep -q 'rolling back to 1.0.1' "$F/run.log" || fail "no rollback"
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "version not rolled back"
[ "$(cat "$I/VERSION")" = 1.0.1 ] || fail "files not rolled back"
tail -n 1 "$I/update.sh" | grep -q '^# release 1.0.1' || fail "update.sh not rolled back"
grep -q '^restored' "$DOCKER_CALLS" || fail "backup not restored"
[ "$(grep -c '^compose up' "$DOCKER_CALLS")" -ge 2 ] || fail "previous version not started"
status | grep -q '"result":"rolled-back","from":"1.0.1","to":"1.0.4"' || fail "rollback not recorded"
ok "1.0.4 unhealthy: back on 1.0.1, database restored, recorded"

step "automatic updates: off by default, patch policy, systemd timer"
run ./update.sh --auto && fail "--auto ran without being enabled"
grep -q 'automatic updates are off' "$F/run.log" || fail "--auto refusal"
CODESH_INIT=systemd CODESH_SYSTEMD_DIR="$F/systemd" run ./update.sh --enable-auto --at 03:30 --policy patch --dry-run ||
  fail "dry run failed"
grep -q 'OnCalendar=\*-\*-\* 03:30:00' "$F/run.log" || fail "dry run timer"
grep -q 'dry-run: systemctl enable --now codesh-update.timer' "$F/run.log" || fail "dry run enable"
[ -e "$F/systemd/codesh-update.timer" ] && fail "dry run wrote the timer"
[ -e "$I/state/auto.conf" ] && fail "dry run enabled auto"
: >"$DOCKER_CALLS"
CODESH_INIT=systemd CODESH_SYSTEMD_DIR="$F/systemd" run ./update.sh --enable-auto --at 03:30 --policy patch || fail "enable failed"
grep -q "ExecStart=$I/update.sh --auto" "$F/systemd/codesh-update.service" || fail "service unit"
grep -q 'OnCalendar=\*-\*-\* 03:30:00' "$F/systemd/codesh-update.timer" || fail "timer unit"
grep -q 'systemctl enable --now codesh-update.timer' "$DOCKER_CALLS" || fail "timer not enabled"
status | grep -q '"auto":{"enabled":true,"at":"03:30","policy":"patch"}' || fail "auto not in status"
status | grep -q '"result":"rolled-back"' || fail "enable lost the last run"
# 1.0.5 is the newest patch of 1.0; 1.1.0 is a minor update the patch policy leaves alone.
run ./update.sh --auto || fail "--auto failed"
[ "$(envv CODESH_VERSION)" = 1.0.5 ] || fail "--auto did not pick 1.0.5"
run ./update.sh --auto || fail "second --auto failed"
grep -q 'codesh 1.0.5 is up to date' "$F/run.log" || fail "--auto went past the patch policy"
CODESH_INIT=systemd CODESH_SYSTEMD_DIR="$F/systemd" run ./update.sh --disable-auto || fail "disable failed"
[ -e "$F/systemd/codesh-update.timer" ] && fail "timer left behind"
grep -q 'systemctl disable --now codesh-update.timer' "$DOCKER_CALLS" || fail "timer not disabled"
status | grep -q '"auto":{"enabled":false' || fail "auto still on in status"
ok "systemd timer on and off; --auto took 1.0.5 and left 1.1.0"

step "cron when there is no systemd"
printf '0 1 * * * echo keep-me\n' >"$CRONTAB_FILE"
CODESH_INIT=cron run ./update.sh --enable-auto --at 04:05 --policy minor || fail "cron enable failed"
grep -q "^5 4 \* \* \* cd '$I' && ./update.sh --auto" "$CRONTAB_FILE" || fail "cron entry"
grep -q keep-me "$CRONTAB_FILE" || fail "other cron entries lost"
CODESH_INIT=cron run ./update.sh --enable-auto --at 04:05 --policy minor || fail "cron re-enable failed"
[ "$(grep -c 'codesh-update' "$CRONTAB_FILE")" = 1 ] || fail "duplicate cron entries"
CODESH_INIT=cron run ./update.sh --disable-auto || fail "cron disable failed"
grep -q codesh-update "$CRONTAB_FILE" && fail "cron entry left behind"
grep -q keep-me "$CRONTAB_FILE" || fail "other cron entries lost on disable"
run ./update.sh --enable-auto --at 25:00 && fail "accepted --at 25:00"
ok "cron entry added once, removed, other entries kept; bad time refused"

step "a source checkout is not updated in place"
mkdir -p "$F/checkout/deploy" && touch "$F/checkout/package.json" && mkdir "$F/checkout/.git"
cp -r "$I"/. "$F/checkout/deploy/"
(cd "$F/checkout/deploy" && ./update.sh --yes) >"$F/run.log" 2>&1 && fail "updated a source checkout"
grep -q 'source checkout' "$F/run.log" || fail "checkout message"
ok "refused with the git pull / docker compose build hint"

printf '\nupdate.test.sh: all checks passed\n'
