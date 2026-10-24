#!/usr/bin/env bash
# End-to-end check of deploy/update.sh with real images on a docker host: a local registry stands
# in for GHCR and a local HTTP server for GitHub (release list, SHA256SUMS, deploy archives).
#
#   bash deploy/verify-update.sh          from the repository root (scripts/box 'bash deploy/verify-update.sh')
#
# Builds the images once and publishes them as 1.0.0, 1.0.1 and a 1.0.2 whose api never starts;
# makes the release files with bundle.sh (BUNDLE_SOURCE=registry, as release.yml does); installs
# 1.0.0 from its offline bundle; updates to 1.0.1 (pull, digest check, /healthz, /readyz, data
# kept, status in the admin API); then tries 1.0.2 and checks the rollback (1.0.1 runs again with
# the database of just before). Own registry, compose project, ports and subnet; all removed at
# the end unless KEEP=1. Needs curl, python3 and unzip, about 3 GiB free for docker and 2 GiB in
# VERIFY_DIR (registry data and bundles live there, not in the docker root). VERIFY_PRUNE_CACHE=1
# drops the build cache after the builds, for small shared hosts.
set -euo pipefail

ROOT="$(pwd)"
WORK="${VERIFY_DIR:-/data/workspace/codesh-verify-update}"
REG_PORT="${VERIFY_REGISTRY_PORT:-5055}"
REG="localhost:$REG_PORT/kim0040"
P=18480
PROJECT=codesh-verify-update
INSTALL="$WORK/install"
SRV="$WORK/srv"
export TMPDIR="$WORK/tmp"
SERVER_PID=""

step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  [ -f "$WORK/bad.log" ] && grep -v '^ Container' "$WORK/bad.log" | tail -n 40 >&2
  exit 1
}
free_gib() { df -Pk "$1" | awk 'NR == 2 {print int($4 / 1048576)}'; }

teardown() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  if [ -f "$INSTALL/docker-compose.yml" ]; then
    (cd "$INSTALL" && COMPOSE_PROJECT_NAME=$PROJECT docker compose down -v --remove-orphans) >/dev/null 2>&1 || true
  fi
  docker rm -fv codesh-verify-registry >/dev/null 2>&1 || true
  # The registry writes as root.
  [ -d "$WORK/registry" ] && docker run --rm -v "$WORK:/w" --entrypoint rm registry:2.8.3 -rf /w/registry
  docker image ls --format '{{.Repository}}:{{.Tag}}' | grep "^$REG/" | xargs -r docker image rm -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
cleanup() { [ "${KEEP:-}" = 1 ] || teardown; }
trap cleanup EXIT

in_install() { (cd "$INSTALL" && COMPOSE_PROJECT_NAME=$PROJECT "$@"); }
envv() { sed -n "s/^$1=//p" "$INSTALL/.env" | tail -n 1; }
call() {
  local path="$1"
  shift
  curl -fsS -b "$WORK/jar" -c "$WORK/jar" -H 'X-Codesh: 1' "$@" "http://127.0.0.1:$P$path"
}
create_data() {
  call /api/shares -H 'Content-Type: application/json' \
    -d "{\"title\":\"verify\",\"files\":[{\"path\":\"main.py\",\"content\":\"print(\\\"$1\\\")\\n\"}]}" |
    sed -n 's/.*"id":"\([0-9A-Za-z]\{8\}\)".*/\1/p'
}
has_marker() {
  call "/api/shares/$1/download" -o "$WORK/download.zip" && unzip -p "$WORK/download.zip" | grep -q "$2"
}
admin_update() { call /api/admin/update -H "Authorization: Bearer $(envv ADMIN_TOKEN)"; }

teardown
mkdir -p "$TMPDIR" "$INSTALL" "$SRV/api/repos/kim0040/codesh" "$WORK/registry"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
[ "$(free_gib "$DOCKER_ROOT")" -ge 3 ] || fail "less than 3 GiB free in $DOCKER_ROOT: a full disk breaks every stack on this host"
[ "$(free_gib "$WORK")" -ge 2 ] || fail "less than 2 GiB free in $WORK"
# bundle.sh reads ../package.json, ../docs and ../CHANGELOG.md; a snapshot keeps the run stable.
cp -r "$ROOT/deploy" "$WORK/deploy"
rm -rf "$WORK/deploy/dist" "$WORK/deploy/state"/* "$WORK/deploy/.env"
mkdir -p "$WORK/docs" && cp "$ROOT/package.json" "$ROOT/CHANGELOG.md" "$WORK/" && cp "$ROOT"/docs/*.md "$WORK/docs/"

step "local registry and images 1.0.0, 1.0.1, 1.0.2 (api of 1.0.2 exits at once)"
docker run -d --name codesh-verify-registry -p "127.0.0.1:$REG_PORT:5000" -v "$WORK/registry:/var/lib/registry" \
  registry:2.8.3 >/dev/null
for _ in $(seq 30); do curl -fs "http://localhost:$REG_PORT/v2/" >/dev/null && break; sleep 1; done
BUILD_ENV="$WORK/build.env"
printf 'SESSION_SECRET=x\nCOLLAB_SECRET=x\nMONGO_PASSWORD=x\nMONGO_APP_PASSWORD=x\nVALKEY_PASSWORD=x\nCODESH_VERSION=1.0.0\nCODESH_REGISTRY=%s\n' "$REG" >"$BUILD_ENV"
# One at a time, so the build cache of one image is gone before the next on a small host.
for service in api collab caddy mdns; do
  [ "$(free_gib "$DOCKER_ROOT")" -ge 3 ] || fail "less than 3 GiB free in $DOCKER_ROOT before building $service"
  docker compose --env-file "$BUILD_ENV" --profile mdns -f "$ROOT/deploy/docker-compose.yml" build "$service"
  if [ "${VERIFY_PRUNE_CACHE:-}" = 1 ]; then docker builder prune -af | tail -n 1; fi
done
for name in api collab web mdns; do
  docker push -q "$REG/codesh-$name:1.0.0" >/dev/null
  for v in 1.0.1 1.0.2; do
    if [ "$name" = api ] && [ "$v" = 1.0.2 ]; then
      printf 'FROM %s\nCMD ["node", "-e", "process.exit(1)"]\n' "$REG/codesh-api:1.0.0" |
        docker build -q -t "$REG/codesh-api:1.0.2" - >/dev/null
    else
      # Its own layer, so 1.0.1 has its own digest like a real release.
      printf 'FROM %s\nLABEL org.opencontainers.image.version=%s\n' "$REG/codesh-$name:1.0.0" "$v" |
        docker build -q -t "$REG/codesh-$name:$v" - >/dev/null
    fi
    docker push -q "$REG/codesh-$name:$v" >/dev/null
  done
done
ok "pushed codesh-{api,collab,web,mdns}:{1.0.0,1.0.1,1.0.2} to $REG"

step "release files with bundle.sh, from the registry"
[ "$(free_gib "$DOCKER_ROOT")" -ge 3 ] || fail "less than 3 GiB free in $DOCKER_ROOT after the builds"
for v in 1.0.0 1.0.1 1.0.2; do
  (cd "$WORK/deploy" && BUNDLE_SOURCE=registry CODESH_REGISTRY="$REG" BUNDLE_SUFFIX=-linux-amd64 bash bundle.sh "$v") | tail -n 1
  dir="$SRV/dl/kim0040/codesh/releases/download/v$v"
  mkdir -p "$dir"
  cp "$WORK/deploy/dist/codesh-deploy-$v.tar.gz" "$dir/"
  (cd "$WORK/deploy/dist" && sha256sum "codesh-deploy-$v.tar.gz" "codesh-$v-linux-amd64.tar.gz") >"$dir/SHA256SUMS"
done
tar xzf "$WORK/deploy/dist/codesh-deploy-1.0.1.tar.gz" -O --wildcards '*/IMAGES' | tee "$WORK/images-1.0.1"
grep -c '^codesh-[a-z]* sha256:[0-9a-f]\{64\}$' "$WORK/images-1.0.1" | grep -qx 4 || fail "IMAGES of 1.0.1"
size="$(wc -c <"$WORK/deploy/dist/codesh-1.0.0-linux-amd64.tar.gz")"
[ "$size" -lt 2147483648 ] || fail "bundle is $size bytes"
printf '[{"tag_name":"v1.0.2","prerelease":false},{"tag_name":"v1.0.1","prerelease":false},{"tag_name":"v1.0.0","prerelease":false}]' \
  >"$SRV/api/repos/kim0040/codesh/releases"
SRV_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
python3 -m http.server --bind 127.0.0.1 --directory "$SRV" "$SRV_PORT" >/dev/null 2>&1 &
SERVER_PID=$!
export UPDATE_API_URL="http://127.0.0.1:$SRV_PORT/api" UPDATE_DOWNLOAD_URL="http://127.0.0.1:$SRV_PORT/dl"
export UPDATE_HEALTH_TIMEOUT=90 COMPOSE_PROJECT_NAME=$PROJECT
ok "bundle $((size / 1024 / 1024)) MiB; deploy archives, SHA256SUMS and a release list served on :$SRV_PORT"

step "install 1.0.0 from the offline bundle"
# Only the bundle may provide the images: drop the local tags of 1.0.1 and 1.0.2.
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E "^$REG/codesh-[a-z]+:1\.0\.[12]$" | xargs -r docker image rm -f >/dev/null
tar xzf "$WORK/deploy/dist/codesh-1.0.0-linux-amd64.tar.gz" -C "$INSTALL" --strip-components=1
cp "$INSTALL/.env.example" "$INSTALL/.env"
for kv in HTTP_PORT=$P HTTPS_PORT=18843 NETWORK_SUBNET=172.29.97.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb UPDATE_CHECK=off; do
  sed -i "s|^${kv%%=*}=.*|$kv|" "$INSTALL/.env"
done
in_install ./install.sh | tail -n 2
[ "$(envv CODESH_REGISTRY)" = "$REG" ] || fail "CODESH_REGISTRY not taken from the bundle"
ID="$(create_data marker-one)"
[ -n "$ID" ] && has_marker "$ID" marker-one || fail "no data"
ok "1.0.0 running with share $ID"

step "update.sh --check and an update to 1.0.1"
in_install ./update.sh --check | tee "$WORK/check.log"
grep -q 'installed 1.0.0, newest 1.0.2' "$WORK/check.log" || fail "--check"
in_install ./update.sh --version 1.0.1 --yes | tail -n 4
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "not on 1.0.1"
in_install docker compose ps --format '{{.Service}} {{.Image}} {{.State}}' | tee "$WORK/ps.log"
grep -q "^api $REG/codesh-api:1.0.1 running" "$WORK/ps.log" || fail "api does not run 1.0.1"
grep -q "^caddy $REG/codesh-web:1.0.1 running" "$WORK/ps.log" || fail "caddy does not run 1.0.1"
curl -fsS "http://127.0.0.1:$P/readyz" >/dev/null || fail "/readyz"
has_marker "$ID" marker-one || fail "data lost in the update"
admin_update | tee "$WORK/admin.json" | head -c 400
echo
grep -q '"lastRun":{"at":"[^"]*","result":"updated","from":"1.0.0","to":"1.0.1"' "$WORK/admin.json" ||
  fail "the admin API does not show the run (state/ mount)"
grep -q '"status":"disabled"' "$WORK/admin.json" || fail "UPDATE_CHECK=off not honoured"
ok "1.0.1 pulled, digests checked, healthy, data kept, run visible in /api/admin/update"

step "1.0.2 does not start: update.sh rolls back to 1.0.1 and the backup"
ID2="$(create_data marker-two)"
if in_install ./update.sh --yes >"$WORK/bad.log" 2>&1; then fail "update to a broken release succeeded"; fi
tail -n 8 "$WORK/bad.log"
grep -q 'rolling back to 1.0.1' "$WORK/bad.log" || fail "no rollback"
[ "$(envv CODESH_VERSION)" = 1.0.1 ] || fail "version not rolled back"
curl -fsS "http://127.0.0.1:$P/readyz" >/dev/null || fail "1.0.1 not healthy after the rollback"
in_install docker compose ps --format '{{.Service}} {{.Image}}' | grep -q "^api $REG/codesh-api:1.0.1$" || fail "api not on 1.0.1"
has_marker "$ID" marker-one && has_marker "$ID2" marker-two || fail "data lost in the rollback"
admin_update | grep -q '"result":"rolled-back","from":"1.0.1","to":"1.0.2"' || fail "rollback not in the admin API"
ok "1.0.2 refused by its health check; 1.0.1 runs with both shares"

step "automatic updates (dry run on this host)"
in_install ./update.sh --enable-auto --at 04:00 --policy patch --dry-run

step "done"
echo "verify-update: all checks passed"
