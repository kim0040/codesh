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
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_CALLS"
envfile=.env
compose_file=docker-compose.yml
if [ "$1" = compose ]; then
  shift
  while [[ "${1:-}" == --* || "${1:-}" = -f ]]; do
    case "$1" in
      --env-file) envfile="$2"; shift 2 ;;
      -f) compose_file="$2"; shift 2 ;;
      --project-directory) shift 2 ;;
      *) shift ;;
    esac
  done
  version="$(sed -n 's/^CODESH_VERSION=//p' "$envfile" | tail -1)"
  registry="$(sed -n 's/^CODESH_REGISTRY=//p' "$envfile" | tail -1)"
  registry="${registry:-ghcr.io/kim0040}"
  case "$1" in
    version) exit 0 ;;
    config)
      if [[ "$*" == *--format* ]]; then
        mongo="$(sed -n 's/^    image: \(mongo:[^ ]*\).*/\1/p' "$compose_file" | head -1)"
        printf '{"services":{"mongo":{"image":"%s"}}}\n' "$mongo"
      else for n in web api collab; do printf '%s/codesh-%s:%s\n' "$registry" "$n" "$version"; done; fi ;;
    run)
      while [ "$1" != -e ]; do shift; done
      node "$@" ;;
    pull)
      if [ -n "${FAKE_PULL_BLOCK:-}" ]; then
        touch "$FAKE_PULL_BLOCK.started"
        while [ ! -f "$FAKE_PULL_BLOCK.continue" ]; do sleep .05; done
      fi
      [ -z "${FAKE_PULL_FAIL:-}" ] || exit 1 ;;
    stop)
      [[ "$*" != *caddy* ]] || touch "$FAKE_DB.closed"
      [[ "$*" != *collab* ]] || printf 'shutdown-flushed\n' >>"$FAKE_DB" ;;
    ps) printf 'collab-fixture\n' ;;
    up)
      if [ "$version" = "${FAKE_INGRESS_FAIL:-none}" ] && [[ " $* " != *' api '* ]]; then
        printf 'accepted-at-ingress\n' >>"$FAKE_DB"
        exit 1
      fi
      printf 'up:%s:%s\n' "$version" "$*" >>"$DOCKER_CALLS"
      if [[ " $* " == *' api '* ]]; then
        if [ "$version" = "${FAKE_UNHEALTHY:-none}" ]; then
          printf 'incompatible-schema\n' >"$FAKE_DB"
          echo "container api is unhealthy" >&2; exit 1
        fi
        grep -q incompatible-schema "$FAKE_DB" && { echo 'old API cannot read changed schema' >&2; exit 1; }
      fi ;;
    exec)
      case "${!#}" in
        dump) [ -f "$FAKE_DB.closed" ] || exit 1; cat "$FAKE_DB" ;;
        restore) cat >"$FAKE_DB"; echo restored >>"$DOCKER_CALLS" ;;
        *) exit 0 ;;
      esac ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then printf '%s false\n' "${FAKE_COLLAB_EXIT:-0}"; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  ref="${!#}"
  name="${ref%:*}"
  printf '%s@sha256:%s\n' "$name" "$(printf '%s' "${name##*/}${FAKE_DIGEST_SALT:-}" | sha256sum | cut -c1-64)"
fi
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
export FAKE_DB="$F/database"
printf 'initial-data\n' >"$FAKE_DB"
export PATH="$F/bin:$PATH" DOCKER_CALLS="$F/docker.calls" CRONTAB_FILE="$F/crontab"
export UPDATE_API_URL="$base/api" UPDATE_DOWNLOAD_URL="$base/dl" UPDATE_HEALTH_TIMEOUT=3
digest() { printf '%s' "$1" | sha256sum | cut -c1-64; }

# --- releases: deploy archives laid out as release.yml publishes them ----------------------------
# release <version> [bad-checksum|bad-digest]
release() {
  local v="$1" dir="$F/srv/dl/kim0040/codesh/releases/download/v$1" stage="$F/stage/codesh-$1"
  mkdir -p "$dir" "$stage/docs" "$stage/tls" "$stage/state"
  cp "$root"/deploy/{lib.sh,generate-secrets.sh,install.sh,upgrade.sh,update.sh,backup.sh,restore.sh,docker-compose.yml} "$stage/"
  cp "$root/deploy/README.md" "$stage/README.md"
  printf '# doc\n' >"$stage/docs/OPERATIONS.md"
  printf '# tls\n' >"$stage/tls/tls.example"
  [ "${2:-}" != mongo-change ] || sed -i 's/mongo:8.0.34/mongo:9.0.0/g' "$stage/docker-compose.yml"
  printf '# release %s\n' "$v" >>"$stage/update.sh"
  sed "s/^CODESH_VERSION=.*/CODESH_VERSION=$v/" "$root/deploy/.env.example" >"$stage/.env.example"
  printf 'NEW_IN_%s=yes\n' "${v//./_}" >>"$stage/.env.example"
  printf '%s\n' "$v" >"$stage/VERSION"
  for n in web api collab mdns; do
    if [ "${2:-}" = bad-digest ]; then printf 'codesh-%s sha256:%s\n' "$n" "$(digest "other-$n")"
    else printf 'codesh-%s sha256:%s\n' "$n" "$(digest "codesh-$n")"; fi
  done >"$stage/IMAGES"
  # shellcheck disable=SC2094 # manifest is excluded from find
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
release 1.0.6 mongo-change
release 1.1.0
release 1.1.1
release 2.0.0
releases_json() {
  printf '['
  local first=1 v
  for v in "$@"; do
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"tag_name":"v%s","name":"codesh %s","draft":false,"prerelease":%s,"body":"has tag_name inside"}' \
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
cp "$root"/deploy/{lib.sh,generate-secrets.sh,install.sh,upgrade.sh,update.sh,backup.sh,restore.sh,docker-compose.yml,.env.example,README.md} "$I/"
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
calls | grep -q 'pull$' && fail "pulled during a refusal"
ok "2.0.0 refused without --allow-major, recorded"

step "checksum mismatch: refused before backup or pull"
: >"$DOCKER_CALLS"
run ./update.sh --version 1.0.2 --yes && fail "accepted a tampered archive"
grep -q 'checksum mismatch: codesh-deploy-1.0.2.tar.gz' "$F/run.log" || fail "wrong refusal"
calls | grep -q 'exec -T mongo' && fail "backup ran"
calls | grep -q 'pull$' && fail "pulled"
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
grep -q 'pull$' "$DOCKER_CALLS" || fail "no pull"
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
grep -q '^initial-data$' "$FAKE_DB" || fail "backup data lost"
grep -q '^shutdown-flushed$' "$FAKE_DB" || fail "collab flush not in backup"
python3 - "$DOCKER_CALLS" <<'ORDER'
import sys
s=open(sys.argv[1]).read().splitlines()
r=s.index('restored')
assert not any(x.startswith('up:1.0.1:') and ' api ' in x+' ' for x in s[:r]), s
assert any(x.startswith('up:1.0.1:') and ' api ' in x+' ' for x in s[r+1:]), s
ORDER
ok "1.0.4 changed the DB: restore precedes the old API; pre-backup collab flush survives"

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
status | grep -q '"lastRun":{"at":' || fail "enable lost the last run"
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

step "Mongo image changes are refused before maintenance and backup"
: >"$DOCKER_CALLS"
run ./update.sh --version 1.0.6 --yes && fail "Mongo major change accepted"
grep -q 'supported migration' "$F/run.log" || fail "no Mongo migration refusal"
grep -q 'stop\|dump' "$DOCKER_CALLS" && fail "stopped or backed up before Mongo refusal"
[ "$(envv CODESH_VERSION)" = 1.0.5 ] || fail "Mongo refusal changed files"
ok "Mongo image change refused before any writes or backup"

step "stable parses objects, not tag-like text, and excludes draft/flag-only prerelease"
cp "$F/srv/api/repos/kim0040/codesh/releases" "$F/releases.original"
cat >"$F/srv/api/repos/kim0040/codesh/releases" <<'JSON'
[{"tag_name":"v8.0.0","prerelease":true},{"tag_name":"v9.0.0","draft":true},
 {"tag_name":"v3.0.0-rc.1"},{"tag_name":"v5.0.0-01"},{"tag_name":"v06.0.0"},
 {"tag_name":"v7.0.0-rc..1"},{"tag_name":"v4.0.0","prerelease":"false"},
 {"tag_name":"v1.1.0+build.1","body":"\"tag_name\":\"v99.0.0\""}]
JSON
run ./update.sh --check || fail "mixed releases check"
grep -q 'newest 1.1.0 ' "$F/run.log" || fail "stable picked a draft, prerelease or invalid version"
UPDATE_CHANNEL=prerelease run ./update.sh --check || fail "prerelease check"
grep -q 'newest 8.0.0 ' "$F/run.log" || fail "prerelease channel did not include flag-only prerelease"
mv "$F/releases.original" "$F/srv/api/repos/kim0040/codesh/releases"
ok "mixed JSON list channel rules and semver validation"

step "writes during download/pull and the shutdown flush survive a failed update"
: >"$DOCKER_CALLS"
FAKE_PULL_BLOCK="$F/pull" FAKE_UNHEALTHY=1.1.0 run ./update.sh --version 1.1.0 --yes &
job=$!
for _ in $(seq 100); do [ -f "$F/pull.started" ] && break; sleep .05; done
[ -f "$F/pull.started" ] || fail "pull did not start"
printf 'accepted-during-pull\n' >>"$FAKE_DB"
grep -q 'dump' "$DOCKER_CALLS" && fail "backup happened before downloads completed"
touch "$F/pull.continue"
wait "$job" && fail "bad image succeeded"
grep -q '^accepted-during-pull$' "$FAKE_DB" || fail "write during pull lost"
grep -q '^shutdown-flushed$' "$FAKE_DB" || fail "shutdown flush lost"
ok "writes accepted while pulling are backed up and survive rollback"

step "transaction restores partial cp/mv failures and TERM; no DB restore before app start"
for injection in cp mv term; do
  cat >"$F/bin/$([[ "$injection" = mv ]] && echo mv || echo cp)" <<'INJECT'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [ "$arg" = ./VERSION.new ] && [ ! -f "$INJECT_ONCE" ]; then
    touch "$INJECT_ONCE"
    if [ "$INJECT_MODE" = term ]; then kill -TERM "$PPID"; sleep .1; fi
    exit 1
  fi
done
exec "/bin/$(basename "$0")" "$@"
INJECT
  chmod +x "$F/bin/$([[ "$injection" = mv ]] && echo mv || echo cp)"
  : >"$DOCKER_CALLS"
  INJECT_ONCE="$F/inject-$injection" INJECT_MODE="$injection" run ./update.sh --version 1.1.0 --yes && fail "injected $injection succeeded"
  [ "$(envv CODESH_VERSION)" = 1.0.5 ] || fail "env not restored"
  [ "$(cat "$I/VERSION")" = 1.0.5 ] || fail "partial swap not restored"
  status | grep -q '"result":"rolled-back"' || fail "transaction state unclear"
  grep -q '^restored$' "$DOCKER_CALLS" && fail "restored DB before new app touched it"
  rm -f "$F/bin/cp" "$F/bin/mv"
done
ok "cp, mv (disk-full equivalent), TERM restore files and .env without unnecessary DB restore"

step "offline release SHA256SUMS and a shared lock for every entry point"
# Make an offline archive whose scripts are the same transaction engine.
offline="$F/stage/codesh-1.1.0"
printf 'images\n' >"$offline/images.tar"
# shellcheck disable=SC2094 # manifest is excluded from find
(cd "$offline" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
tar czf "$F/offline.tar.gz" -C "$F/stage" codesh-1.1.0
(cd "$F" && sha256sum offline.tar.gz >SHA256SUMS)
(cd "$I" && . ./lib.sh; install_lock; trap install_unlock EXIT; touch "$F/lock-held"; sleep 3) &
holder=$!
for _ in $(seq 100); do [ -f "$F/lock-held" ] && break; sleep .02; done
for entry in './update.sh --bundle' './upgrade.sh' './restore.sh'; do
  # Deliberate word splitting: each fixture names a command and its fixed flags.
  # shellcheck disable=SC2086
  run $entry "$F/offline.tar.gz" --yes && fail "entrypoint overlapped: $entry"
  grep -q 'another update' "$F/run.log" || fail "not blocked by lock: $entry"
done
run ./update.sh --auto && fail "auto overlapped"
grep -q 'another update' "$F/run.log" || fail "auto not blocked by lock"
wait "$holder"
# Hide flock via a PATH shim for command lookup, while leaving the rest of the host available.
mkdir "$F/no-flock"
for tool in /usr/local/bin/* /usr/bin/* /bin/*; do
  [ -f "$tool" ] || continue
  [ "${tool##*/}" = flock ] || ln -sf "$tool" "$F/no-flock/${tool##*/}"
done
(cd "$I" && PATH="$F/no-flock" bash -c '. ./lib.sh; install_lock; trap install_unlock EXIT; touch "$1"; sleep 3' _ "$F/mkdir-held") &
holder=$!
for _ in $(seq 100); do [ -f "$F/mkdir-held" ] && break; sleep .02; done
PATH="$F/no-flock" run ./update.sh --version 1.1.0 --yes && fail "mkdir fallback overlapped"
wait "$holder"
[ ! -e "$I/state/install.lock.d" ] || fail "mkdir lock leaked"
PATH="$F/bin:$F/no-flock" run ./upgrade.sh "$F/offline.tar.gz" || fail "nested offline update under mkdir lock failed"
[ "$(envv CODESH_VERSION)" = 1.1.0 ] || fail "offline update version"
[ ! -e "$I/state/install.lock.d" ] || fail "nested mkdir lock leaked"
ok "flock + mkdir contention, nested offline upgrade, released SHA256SUMS (no sidecar)"

step "bounded real HTTP requests, redirect refusal, HTTPS Host and SNI arguments"
python3 - "$F/health.port" <<'HEALTH' &
import http.server, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/stall': time.sleep(5)
        self.send_response(302 if self.path == '/redirect' else 204)
        self.end_headers()
    def log_message(self, *args): pass
s=http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
open(sys.argv[1], 'w').write(str(s.server_port))
s.serve_forever()
HEALTH
health=$!
for _ in $(seq 100); do [ -s "$F/health.port" ] && break; sleep .02; done
hp="$(cat "$F/health.port")"
(
  cd "$I"; . ./lib.sh
  env_set HTTP_PORT "$hp"
  SECONDS=0
  wait_healthy 1 /stall && exit 1
  [ "$SECONDS" -le 2 ] || exit 1
  wait_healthy 1 /redirect && exit 1
  wait_healthy 3 /ok || exit 1
) >"$F/health.log" 2>&1 || fail "bounded health checks"
kill "$health"
cat >"$F/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HEALTH_CALLS"
printf 204
CURL
chmod +x "$F/bin/curl"
HEALTH_CALLS="$F/health.args" run bash -c '. ./lib.sh; env_set SITE_ADDRESS https://codesh.corp; env_set HTTPS_PORT 8443; wait_healthy 3 /readyz' || fail "HTTPS health"
grep -q -- '--resolve codesh.corp:8443:127.0.0.1.*--connect-timeout 3 --max-time 3.*https://codesh.corp:8443/readyz' "$F/health.args" || fail "Host/SNI or bounded timeout missing"
rm "$F/bin/curl"
ok "stalled response bounded, 302 refused, only 2xx accepted, correct HTTPS origin/SNI"

step "unsupported scheduler paths fail before modifying systemd or cron"
for suffix in 'with space' "apostrophe'path" 'percent%path'; do
  special="$F/$suffix"
  mkdir "$special"
  cp "$I"/{update.sh,lib.sh,.env} "$special/"
  for init in systemd cron; do
    (cd "$special" && CODESH_INIT="$init" ./update.sh --enable-auto --dry-run) >"$F/run.log" 2>&1 && fail "accepted scheduler path $suffix"
    grep -q 'automatic updates require an install path' "$F/run.log" || fail "path refusal message"
  done
done
ok "space, apostrophe, percent refused for both schedulers"

step "a source checkout is not updated in place"
mkdir -p "$F/checkout/deploy" && touch "$F/checkout/package.json" && mkdir "$F/checkout/.git"
cp -r "$I"/. "$F/checkout/deploy/"
(cd "$F/checkout/deploy" && ./update.sh --yes) >"$F/run.log" 2>&1 && fail "updated a source checkout"
grep -q 'source checkout' "$F/run.log" || fail "checkout message"
ok "refused with the git pull / docker compose build hint"

step "a partly opened ingress must not trigger a DB rollback that discards accepted writes"
: >"$DOCKER_CALLS"
FAKE_INGRESS_FAIL=1.1.1 run ./update.sh --version 1.1.1 --yes && fail "failed ingress reported success"
[ "$(envv CODESH_VERSION)" = 1.1.1 ] || fail "verified version was put back after ingress opened"
grep -q '^accepted-at-ingress$' "$FAKE_DB" || fail "write accepted while ingress opened was lost"
grep -q '^restored$' "$DOCKER_CALLS" && fail "restored an old DB after ingress could accept writes"
status | grep -q 'current files and DB retained' || fail "ingress recovery state unclear"
ok "ingress activation failure stops writers and retains current DB and files for recovery"

printf '\nupdate.test.sh: all checks passed\n'
