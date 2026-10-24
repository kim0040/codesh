#!/usr/bin/env bash
# End-to-end check of the offline production path on a docker host with two bundles:
#
#   deploy/bundle.sh v1 && deploy/bundle.sh v2 && deploy/verify-deploy.sh v1 v2
#
# fresh:  install v1 -> data -> least privilege -> CSP (deploy/verify-security.mjs) -> backup ->
#         restore -> upgrade refused for a changed archive and a changed bundle -> upgrade to v2 ->
#         HTTPS with the internal CA
# legacy: an install made with the deploy scripts from before the application user (root user only)
#         upgraded to v2 by its own, old upgrade.sh. LEGACY_SRC=<dir holding those deploy/ files>,
#         else they are read from git at LEGACY_REF (default 7ff75f0, the last commit before it).
#
# Uses its own compose projects, ports, subnets and VERIFY_DIR, and removes them at the end
# (KEEP=1 keeps them). Run from the repository root; needs curl, sha256sum and unzip.
set -euo pipefail

OLD="${1:?usage: deploy/verify-deploy.sh <old version> <new version>}"
NEW="${2:?usage: deploy/verify-deploy.sh <old version> <new version>}"
ROOT="$(pwd)"
DIST="${VERIFY_DIST:-$ROOT/deploy/dist}"
WORK="${VERIFY_DIR:-/data/workspace/codesh-verify}"
FRESH="$WORK/fresh"
LEGACY="$WORK/legacy"
export TMPDIR="$WORK/tmp"

LEGACY_REF="${LEGACY_REF:-7ff75f0}"
legacy_file() {
  if [ -n "${LEGACY_SRC:-}" ]; then cat "$LEGACY_SRC/deploy/$1"; else git show "$LEGACY_REF:deploy/$1"; fi
}

step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# in <dir> <project> <command...>: runs a command in an installation with its compose project
in_dir() {
  local dir="$1" project="$2"
  shift 2
  (cd "$dir" && COMPOSE_PROJECT_NAME="$project" "$@")
}

setenv() {
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >>"$1"; fi
}

teardown() {
  for spec in "$FRESH:codesh-verify-fresh" "$LEGACY:codesh-verify-legacy"; do
    dir="${spec%%:*}"
    project="${spec##*:}"
    if [ -f "$dir/docker-compose.yml" ]; then
      in_dir "$dir" "$project" docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$WORK"
}
cleanup() { [ "${KEEP:-}" = 1 ] || teardown; }
trap cleanup EXIT

# call <port> <jar> <path> <curl args...>: a same-origin API call with the session cookie of <jar>
call() {
  local port="$1" jar="$2" path="$3"
  shift 3
  curl -fsS -b "$jar" -c "$jar" -H 'X-Codesh: 1' "$@" "http://127.0.0.1:$port$path"
}
status() {
  curl -s -o /dev/null -w '%{http_code}' -b "$2" -H 'X-Codesh: 1' "http://127.0.0.1:$1$3"
}

# create_data <port> <jar>: prints the id of a share whose single file holds a marker
create_data() {
  call "$1" "$2" /api/shares -H 'Content-Type: application/json' \
    -d '{"title":"verify","files":[{"path":"main.py","content":"print(\"restore-marker\")\n"}]}' |
    sed -n 's/.*"id":"\([0-9A-Za-z]\{8\}\)".*/\1/p'
}
# has_marker <port> <jar> <id>: the share's download (a zip) contains the marker
has_marker() {
  call "$1" "$2" "/api/shares/$3/download" -o "$WORK/download.zip" &&
    unzip -p "$WORK/download.zip" | grep -q restore-marker
}

# least_privilege <dir> <project>: api connects as a user that can write codesh but not admin
least_privilege() {
  local out
  out="$(in_dir "$1" "$2" docker compose exec -T api node --input-type=module -e '
    import { MongoClient } from "mongodb";
    const c = await MongoClient.connect(process.env.MONGO_URL);
    try {
      const { authInfo } = await c.db("codesh").command({ connectionStatus: 1 });
      await c.db("codesh").collection("verify_probe").insertOne({ ok: true });
      await c.db("codesh").collection("verify_probe").drop();
      let denied = false;
      try { await c.db("admin").command({ serverStatus: 1 }); } catch (e) { denied = e.code === 13; }
      console.log(JSON.stringify({ users: authInfo.authenticatedUsers, adminDenied: denied }));
    } finally { await c.close(); }')"
  echo "$out"
  grep -q '"user":"codesh_app","db":"codesh"' <<<"$out" || fail "api does not use codesh_app"
  grep -q '"adminDenied":true' <<<"$out" || fail "api has admin privileges"
}

no_password_in_ps() {
  local pw count
  pw="$(sed -n 's/^VALKEY_PASSWORD=//p' "$1/.env")"
  count="$(ps -eo args | awk -v p="$pw" 'index($0, p) && !/awk/' | wc -l)"
  [ "$count" -eq 0 ] || fail "the Valkey password is visible in ps ($count processes)"
  pw="$(sed -n 's/^MONGO_PASSWORD=//p' "$1/.env")"
  count="$(ps -eo args | awk -v p="$pw" 'index($0, p) && !/awk/' | wc -l)"
  [ "$count" -eq 0 ] || fail "the Mongo root password is visible in ps ($count processes)"
  ok "no secret in the arguments of any host process"
}

teardown
mkdir -p "$TMPDIR" "$FRESH" "$LEGACY"

step "bundle checksums"
(cd "$DIST" && sha256sum -c "codesh-$OLD.tar.gz.sha256" "codesh-$NEW.tar.gz.sha256")

step "fresh install of $OLD"
P="${VERIFY_HTTP_PORT:-18280}"
TLS_PORT="${VERIFY_HTTPS_PORT:-18643}"
FJ="$WORK/fresh.jar"
tar xzf "$DIST/codesh-$OLD.tar.gz" -C "$FRESH" --strip-components=1
cp "$FRESH/.env.example" "$FRESH/.env"
for kv in HTTP_PORT=$P HTTPS_PORT=$TLS_PORT NETWORK_SUBNET=172.29.95.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb; do
  setenv "$FRESH/.env" "${kv%%=*}" "${kv#*=}"
done
in_dir "$FRESH" codesh-verify-fresh ./install.sh
[ "$(stat -c %a "$FRESH/.env")" = 600 ] || fail ".env is not 0600"
in_dir "$FRESH" codesh-verify-fresh docker compose ps -a mongo-users --format '{{.Service}} {{.State}} exit={{.ExitCode}}'
least_privilege "$FRESH" codesh-verify-fresh
no_password_in_ps "$FRESH"

step "data"
ID="$(create_data "$P" "$FJ")"
[ -n "$ID" ] || fail "share not created"
has_marker "$P" "$FJ" "$ID" || fail "share content missing"
UPLOAD="$(call "$P" "$FJ" /api/uploads -F "file=@$FRESH/VERSION;filename=notes.txt")"
echo "share $ID, upload $UPLOAD"
ok "share and upload created"

step "metrics"
[ "$(status "$P" "$FJ" /metrics/api)" = 200 ] || fail "/metrics/api from the host"
[ "$(status "$P" "$FJ" /metrics)" = 403 ] || fail "/metrics must be refused"
ok "metrics: host 200, /metrics 403"

step "CSP and offline browser run"
node deploy/verify-security.mjs "http://127.0.0.1:$P"

step "backup"
B="$(in_dir "$FRESH" codesh-verify-fresh ./backup.sh "$WORK/backups")"
echo "$B"
FILE="$(sed -n 's/^backup: \(.*\) (.*/\1/p' <<<"$B")"
[ "$(stat -c %a "$FILE")" = 600 ] || fail "backup is not 0600"
[ "$(stat -c %a "$WORK/backups")" = 700 ] || fail "backup directory is not 0700"
ok "backup $(stat -c '%a %s' "$FILE")"

step "restore"
call "$P" "$FJ" "/api/shares/$ID" -o /dev/null -X DELETE
[ "$(status "$P" "$FJ" "/api/shares/$ID")" = 404 ] || fail "share not deleted"
in_dir "$FRESH" codesh-verify-fresh ./restore.sh "$FILE" --yes
[ "$(status "$P" "$FJ" "/api/shares/$ID")" = 200 ] || fail "share not restored"
has_marker "$P" "$FJ" "$ID" || fail "restored content missing"
least_privilege "$FRESH" codesh-verify-fresh
ok "deleted share is back with its content"

step "upgrade refuses a changed archive"
mkdir -p "$WORK/bad"
cp "$DIST/codesh-$NEW.tar.gz" "$DIST/codesh-$NEW.tar.gz.sha256" "$WORK/bad/"
printf 'x' >>"$WORK/bad/codesh-$NEW.tar.gz"
backups() { if [ -d "$FRESH/backups" ]; then find "$FRESH/backups" -type f | wc -l; else echo 0; fi; }
BACKUPS="$(backups)"
if in_dir "$FRESH" codesh-verify-fresh ./upgrade.sh "$WORK/bad/codesh-$NEW.tar.gz" >"$WORK/bad.log" 2>&1; then
  fail "upgrade accepted a changed archive"
fi
cat "$WORK/bad.log"
grep -q 'bundle checksum mismatch' "$WORK/bad.log" || fail "wrong refusal"
[ "$(sed -n 's/^CODESH_VERSION=//p' "$FRESH/.env")" = "$OLD" ] || fail "version changed"
[ "$(backups)" = "$BACKUPS" ] || fail "upgrade ran a backup"
ok "changed archive refused before backup, extraction and image load"

step "upgrade refuses a changed bundle with a matching archive checksum"
rm -rf "$WORK/bad"
mkdir -p "$WORK/bad/x"
tar xzf "$DIST/codesh-$NEW.tar.gz" -C "$WORK/bad/x"
printf '# changed\n' >>"$WORK/bad/x/codesh-$NEW/docker-compose.yml"
tar czf "$WORK/bad/codesh-$NEW.tar.gz" -C "$WORK/bad/x" "codesh-$NEW"
rm -rf "$WORK/bad/x"
(cd "$WORK/bad" && sha256sum "codesh-$NEW.tar.gz" >"codesh-$NEW.tar.gz.sha256")
if in_dir "$FRESH" codesh-verify-fresh ./upgrade.sh "$WORK/bad/codesh-$NEW.tar.gz" >"$WORK/bad.log" 2>&1; then
  fail "upgrade accepted a changed bundle"
fi
cat "$WORK/bad.log"
grep -q 'bundle content checksum mismatch' "$WORK/bad.log" || fail "wrong refusal"
[ "$(sed -n 's/^CODESH_VERSION=//p' "$FRESH/.env")" = "$OLD" ] || fail "version changed"
rm -rf "$WORK/bad"
ok "changed bundle refused"

step "upgrade $OLD -> $NEW"
in_dir "$FRESH" codesh-verify-fresh ./upgrade.sh "$DIST/codesh-$NEW.tar.gz"
[ "$(sed -n 's/^CODESH_VERSION=//p' "$FRESH/.env")" = "$NEW" ] || fail "version not updated"
has_marker "$P" "$FJ" "$ID" || fail "content missing after upgrade"
least_privilege "$FRESH" codesh-verify-fresh
ok "upgraded, data kept"

step "HTTPS with the internal CA"
cp "$FRESH/tls/internal.caddy.example" "$FRESH/tls/local.caddy"
setenv "$FRESH/.env" SITE_ADDRESS localhost
setenv "$FRESH/.env" PUBLIC_URL "https://localhost:$TLS_PORT"
in_dir "$FRESH" codesh-verify-fresh docker compose up -d --wait caddy api
in_dir "$FRESH" codesh-verify-fresh docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt"
curl -fsS --cacert "$WORK/root.crt" -D "$WORK/https.headers" -o /dev/null "https://localhost:$TLS_PORT/api/session"
grep -Eiq '^set-cookie:.*; secure' "$WORK/https.headers" || fail "session cookie is not Secure"
curl -fsS --cacert "$WORK/root.crt" -D "$WORK/hsts.headers" -o /dev/null "https://localhost:$TLS_PORT/"
grep -Eiq '^strict-transport-security: max-age=31536000' "$WORK/hsts.headers" || fail "no HSTS"
grep -Eiq '^content-security-policy:' "$WORK/hsts.headers" || fail "no CSP over HTTPS"
ok "HTTPS: trusted local CA, Secure cookie, HSTS, CSP"

step "legacy install (root user only) upgraded by its own upgrade.sh"
LP="${VERIFY_LEGACY_HTTP_PORT:-18380}"
# Shared verification hosts may allocate only one HTTP/HTTPS pair to this worker.
if [ "$LP" = "$P" ]; then in_dir "$FRESH" codesh-verify-fresh docker compose down; fi
LJ="$WORK/legacy.jar"
for f in .env.example lib.sh generate-secrets.sh install.sh upgrade.sh backup.sh restore.sh; do
  legacy_file "$f" >"$LEGACY/$f"
done
legacy_file docker-compose.yml |
  awk '/^    build:/ { skip = 1; next } skip && /^      / { next } { skip = 0; print }' |
  # Legacy Compose predates CODESH_REGISTRY and the codesh-web image name.
  sed -e "s|image: codesh/caddy:|image: $(sed -n 's/^CODESH_REGISTRY=//p' "$FRESH/.env" | tail -n 1)/codesh-web:|" \
      -e "s|image: codesh/|image: $(sed -n 's/^CODESH_REGISTRY=//p' "$FRESH/.env" | tail -n 1)/codesh-|" >"$LEGACY/docker-compose.yml"
chmod +x "$LEGACY"/*.sh
mkdir -p "$LEGACY/tls"
ln -s "$FRESH/images.tar" "$LEGACY/images.tar"
printf '%s\n' "$OLD" >"$LEGACY/VERSION"
cp "$LEGACY/.env.example" "$LEGACY/.env"
setenv "$LEGACY/.env" CODESH_REGISTRY "$(sed -n 's/^CODESH_REGISTRY=//p' "$FRESH/.env" | tail -n 1)"
for kv in HTTP_PORT=$LP HTTPS_PORT="${VERIFY_LEGACY_HTTPS_PORT:-18743}" NETWORK_SUBNET=172.29.96.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb; do
  setenv "$LEGACY/.env" "${kv%%=*}" "${kv#*=}"
done
in_dir "$LEGACY" codesh-verify-legacy ./install.sh
grep -q MONGO_APP_PASSWORD "$LEGACY/.env" && fail "legacy .env already knows the app user"
LID="$(create_data "$LP" "$LJ")"
has_marker "$LP" "$LJ" "$LID" || fail "legacy share content missing"
# The old upgrade.sh finishes, then its EXIT trap fails on a function-local variable ("tmp:
# unbound variable"), exits 1 and leaves the extracted bundle in TMPDIR. Accept exactly that.
if ! in_dir "$LEGACY" codesh-verify-legacy ./upgrade.sh "$DIST/codesh-$NEW.tar.gz" >"$WORK/legacy-upgrade.log" 2>&1; then
  tail -3 "$WORK/legacy-upgrade.log"
  grep -q "upgrade: codesh $NEW is running" "$WORK/legacy-upgrade.log" || fail "legacy upgrade failed"
  grep -q 'tmp: unbound variable' "$WORK/legacy-upgrade.log" || fail "legacy upgrade failed"
  echo "known: the old upgrade.sh exits 1 after a successful upgrade (trap bug fixed in this version)"
fi
[ "$(sed -n 's/^CODESH_VERSION=//p' "$LEGACY/.env")" = "$NEW" ] || fail "legacy version not updated"
grep -Eq '^MONGO_APP_PASSWORD=[0-9a-f]{64}$' "$LEGACY/.env" || fail "no app password generated"
[ -w "$LEGACY/state" ] || fail "legacy status mount is not writable by the operator"
# The old upgrader has a fixed file list that omits update.sh. Follow OPERATIONS 15.5 using
# the matching bundle whose archive checksum and content were verified above.
in_dir "$LEGACY" codesh-verify-legacy ./upgrade.sh "$DIST/codesh-$NEW.tar.gz" >"$WORK/legacy-bootstrap.log" 2>&1 &&
  fail "legacy wrapper accepted a missing update.sh"
grep -q 'copy it from the verified bundle' "$WORK/legacy-bootstrap.log" || fail "missing legacy transition advice"
tar xzf "$DIST/codesh-$NEW.tar.gz" -O "codesh-$NEW/update.sh" >"$LEGACY/update.sh"
chmod +x "$LEGACY/update.sh"
in_dir "$LEGACY" codesh-verify-legacy ./update.sh --bundle "$DIST/codesh-$NEW.tar.gz" >"$WORK/legacy-bootstrap.log" 2>&1
grep -q "codesh $NEW is up to date" "$WORK/legacy-bootstrap.log" || fail "legacy updater was not installed"
has_marker "$LP" "$LJ" "$LID" || fail "legacy content missing after upgrade"
least_privilege "$LEGACY" codesh-verify-legacy
no_password_in_ps "$LEGACY"
B="$(in_dir "$LEGACY" codesh-verify-legacy ./backup.sh)"
echo "$B"
ok "legacy volume upgraded in place to the least-privilege user, data kept, backup works"

step "done"
echo "verify-deploy: all checks passed ($OLD -> $NEW)"
