#!/usr/bin/env bash
# End-to-end check of deploy/update.sh with real images on a docker host: a local registry stands
# in for GHCR and a local HTTP server for GitHub (release list, SHA256SUMS, deploy archives).
#
#   bash deploy/verify-update.sh          from the repository root, on a docker host
#
# Builds the images once and publishes them as 1.0.0, 1.0.1 and a 1.0.2 whose api never starts;
# makes the release files with bundle.sh (BUNDLE_SOURCE=registry, as release.yml does); installs
# 1.0.0 from its offline bundle; updates to 1.0.1 (pull, digest check, /healthz, /readyz, data
# kept, status in the admin API); then tries 1.0.2 and checks the rollback (1.0.1 runs again with
# the database of just before). Own registry, compose project, ports and subnet; all removed at
# the end unless KEEP=1. Needs curl, python3 and unzip, about 3 GiB free for docker and 2 GiB in
# VERIFY_DIR (registry data and bundles live there, not in the docker root). VERIFY_REUSE_IMAGES=1
# uses existing Collab/base Caddy layers on small shared hosts (API and web assets stay current).
set -euo pipefail

# legacy codesh name (1.0.x); remove in 2.0
# Exercises the actual published 1.0.1 bundle and its installed updater against this source tree.
if [ "${1:-}" = --rename ]; then exec bash deploy/verify-rename.sh; fi

ROOT="$(pwd)"
WORK="${VERIFY_DIR:-/data/workspace/gachipad-verify-update}"
REG_PORT="${VERIFY_REGISTRY_PORT:-5055}"
REG="localhost:$REG_PORT/kim0040"
P="${VERIFY_HTTP_PORT:-18480}"
PROJECT=gachipad-verify-update
INSTALL="$WORK/install"
SRV="$WORK/srv"
export TMPDIR="$WORK/tmp"
SERVER_PID=""
OWNED_REGISTRY=0
MIN_DOCKER_GIB="${VERIFY_MIN_DOCKER_GIB:-3}"

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
  if [ "$OWNED_REGISTRY" = 1 ]; then docker rm -fv gachipad-verify-registry >/dev/null 2>&1 || true; fi
  # The registry writes as root.
  if [ "$OWNED_REGISTRY" = 1 ] && [ -d "$WORK/registry" ]; then
    docker run --rm --pull never -v "$WORK:/w" --entrypoint rm registry:2.8.3 -rf /w/registry
  fi
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
  curl -fsS -b "$WORK/jar" -c "$WORK/jar" -H 'X-Gachipad: 1' "$@" "http://127.0.0.1:$P$path"
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

[ ! -e "$WORK" ] || fail "$WORK already exists; choose a fresh VERIFY_DIR"
mkdir -p "$TMPDIR" "$INSTALL" "$SRV/api/repos/kim0040/gachipad" "$WORK/registry"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
[ "$(free_gib "$DOCKER_ROOT")" -ge "$MIN_DOCKER_GIB" ] || fail "less than $MIN_DOCKER_GIB GiB free in $DOCKER_ROOT: a full disk breaks every stack on this host"
[ "$(free_gib "$WORK")" -ge 2 ] || fail "less than 2 GiB free in $WORK"
# bundle.sh reads ../package.json, ../docs, ../CHANGELOG.md, ../LICENSE and ../THIRD_PARTY_NOTICES.md; a snapshot keeps the run stable.
cp -r "$ROOT/deploy" "$WORK/deploy"
rm -rf "$WORK/deploy/dist" "$WORK/deploy/state"/* "$WORK/deploy/.env"
mkdir -p "$WORK/docs" && cp "$ROOT/package.json" "$ROOT/CHANGELOG.md" "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$WORK/" && cp "$ROOT"/docs/*.md "$WORK/docs/"

step "local registry and images (1.0.2 mutates MongoDB then fails; old API rejects that schema)"
df -h /
docker run -d --name gachipad-verify-registry -p "127.0.0.1:$REG_PORT:5000" -v "$WORK/registry:/var/lib/registry" \
  registry:2.8.3 >/dev/null
OWNED_REGISTRY=1
for _ in $(seq 30); do curl -fs "http://localhost:$REG_PORT/v2/" >/dev/null && break; sleep 1; done
BUILD_ENV="$WORK/build.env"
printf 'SESSION_SECRET=x\nCOLLAB_SECRET=x\nMONGO_PASSWORD=x\nMONGO_APP_PASSWORD=x\nPOSTGRES_PASSWORD=x\nVALKEY_PASSWORD=x\nGACHIPAD_DB=mongodb\nCOMPOSE_PROFILES=mongodb\nGACHIPAD_VERSION=1.0.0\nGACHIPAD_REGISTRY=%s\n' "$REG" >"$BUILD_ENV"
# Existing real images may serve as bases on a small shared box. No preview/dev containers,
# tags, volumes or build cache are removed. Default remains a full source build.
for service in api collab caddy mdns; do
  df -h /
  [ "$(free_gib "$DOCKER_ROOT")" -ge "$MIN_DOCKER_GIB" ] || fail "not enough space before building $service"
  name="$service"; [ "$name" != caddy ] || name=web
  base=""
  if [ "${VERIFY_REUSE_IMAGES:-0}" = 1 ]; then
    case "$service" in
      collab) base="gachipad/$service:preview" ;;
      caddy) base="gachipad/caddy:preview" ;;
    esac
  fi
  if [ "$service" = caddy ] && [ -n "$base" ]; then
    # The preview may predate the update feature. Use this tree's web assets and edge routes.
    pnpm --filter @gachipad/web build >/dev/null
    node deploy/caddy/csp.mjs
    mkdir -p "$WORK/build-web"
    cp Caddyfile.production "$WORK/build-web/Caddyfile"
    cp -r apps/web/dist "$WORK/build-web/dist"
    printf 'FROM %s\nRUN rm -rf /srv\nCOPY Caddyfile /etc/caddy/Caddyfile\nCOPY dist /srv\n' "$base" >"$WORK/build-web/Dockerfile"
    df -h /
    docker build -q -t "$REG/gachipad-$name:1.0.0" "$WORK/build-web" >/dev/null
  elif [ -n "$base" ]; then docker tag "$base" "$REG/gachipad-$name:1.0.0"
  else docker compose --env-file "$BUILD_ENV" --profile mdns --profile mongodb -f "$ROOT/deploy/docker-compose.yml" build "$service"; fi
done
# The previous version cannot boot against the deliberate schema marker. This detects rollback
# that incorrectly starts the old API before restoring, rather than merely checking old health.
mkdir -p "$WORK/build"
cat >"$WORK/build/old-guard.mjs" <<'GUARD'
import { MongoClient } from "mongodb";
const c = await MongoClient.connect(process.env.MONGO_URL);
const broken = await c.db().collection("update_failure_marker").findOne({});
await c.close();
if (broken) { console.error("old API refuses changed schema"); process.exit(1); }
await import("./src/main.ts");
GUARD
cat >"$WORK/build/bad-api.mjs" <<'BAD'
import { MongoClient } from "mongodb";
const c = await MongoClient.connect(process.env.MONGO_URL);
await c.db().collection("update_failure_marker").insertOne({ incompatible: true });
await c.db().collection("shares").deleteMany({});
await c.close();
console.error("new API changed schema and deleted shares, then failed");
await new Promise(resolve => setTimeout(resolve, 5000));
process.exit(1);
BAD
printf 'FROM %s\nCOPY old-guard.mjs /app/old-guard.mjs\nCMD ["node", "--import", "/opt/tsx/node_modules/tsx/dist/esm/index.mjs", "old-guard.mjs"]\n' "$REG/gachipad-api:1.0.0" >"$WORK/build/Dockerfile"
df -h /
docker build -q -t "$REG/gachipad-api:1.0.0" -f "$WORK/build/Dockerfile" "$WORK/build" >/dev/null
for name in api collab web mdns; do
  docker push -q "$REG/gachipad-$name:1.0.0" >/dev/null
  for v in 1.0.1 1.0.2; do
    if [ "$name" = api ] && [ "$v" = 1.0.2 ]; then
      printf 'FROM %s\nCOPY bad-api.mjs /app/bad-api.mjs\nCMD ["node", "bad-api.mjs"]\n' "$REG/gachipad-api:1.0.0" >"$WORK/build/Dockerfile"
      df -h /
      docker build -q -t "$REG/gachipad-api:1.0.2" -f "$WORK/build/Dockerfile" "$WORK/build" >/dev/null
    else
      df -h /
      # Its own layer, so 1.0.1 has its own digest like a real release.
      printf 'FROM %s\nLABEL org.opencontainers.image.version=%s\n' "$REG/gachipad-$name:1.0.0" "$v" |
        docker build -q -t "$REG/gachipad-$name:$v" - >/dev/null
    fi
    docker push -q "$REG/gachipad-$name:$v" >/dev/null
  done
done
ok "pushed gachipad-{api,collab,web,mdns}:{1.0.0,1.0.1,1.0.2} to $REG"

step "release files with bundle.sh, from the registry"
[ "$(free_gib "$DOCKER_ROOT")" -ge "$MIN_DOCKER_GIB" ] || fail "less than $MIN_DOCKER_GIB GiB free in $DOCKER_ROOT after the builds"
for v in 1.0.0 1.0.1 1.0.2; do
  df -h /
  (cd "$WORK/deploy" && BUNDLE_SOURCE=registry GACHIPAD_REGISTRY="$REG" BUNDLE_SUFFIX=-linux-amd64 bash bundle.sh "$v") | tail -n 1
  dir="$SRV/dl/kim0040/gachipad/releases/download/v$v"
  mkdir -p "$dir"
  cp "$WORK/deploy/dist/gachipad-deploy-$v.tar.gz" "$dir/"
  (cd "$WORK/deploy/dist" && sha256sum "gachipad-deploy-$v.tar.gz" "gachipad-$v-linux-amd64.tar.gz") >"$dir/SHA256SUMS"
done
tar xzf "$WORK/deploy/dist/gachipad-deploy-1.0.1.tar.gz" -O --wildcards '*/IMAGES' | tee "$WORK/images-1.0.1"
grep -c '^gachipad-[a-z]* sha256:[0-9a-f]\{64\}$' "$WORK/images-1.0.1" | grep -qx 4 || fail "IMAGES of 1.0.1"
size="$(wc -c <"$WORK/deploy/dist/gachipad-1.0.0-linux-amd64.tar.gz")"
[ "$size" -lt 2147483648 ] || fail "bundle is $size bytes"
printf '[{"tag_name":"v1.0.2","prerelease":false},{"tag_name":"v1.0.1","prerelease":false},{"tag_name":"v1.0.0","prerelease":false}]' \
  >"$SRV/api/repos/kim0040/gachipad/releases"
SRV_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
python3 -m http.server --bind 127.0.0.1 --directory "$SRV" "$SRV_PORT" >/dev/null 2>&1 &
SERVER_PID=$!
export UPDATE_API_URL="http://127.0.0.1:$SRV_PORT/api" UPDATE_DOWNLOAD_URL="http://127.0.0.1:$SRV_PORT/dl"
export UPDATE_HEALTH_TIMEOUT=90 COMPOSE_PROJECT_NAME=$PROJECT
ok "bundle $((size / 1024 / 1024)) MiB; deploy archives, SHA256SUMS and a release list served on :$SRV_PORT"

step "install 1.0.0 from the offline bundle"
# Only the bundle may provide the images: drop the local tags of 1.0.1 and 1.0.2.
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E "^$REG/gachipad-[a-z]+:1\.0\.[12]$" | xargs -r docker image rm -f >/dev/null
tar xzf "$WORK/deploy/dist/gachipad-1.0.0-linux-amd64.tar.gz" -C "$INSTALL" --strip-components=1
cp "$INSTALL/.env.example" "$INSTALL/.env"
for kv in HTTP_PORT=$P HTTPS_PORT="${VERIFY_HTTPS_PORT:-18843}" NETWORK_SUBNET=172.29.97.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb UPDATE_CHECK=off GACHIPAD_DB=mongodb; do
  sed -i "s|^${kv%%=*}=.*|$kv|" "$INSTALL/.env"
done
GACHIPAD_MDNS=0 in_install ./install.sh | tail -n 2
rm "$INSTALL/images.tar"
[ "$(envv GACHIPAD_REGISTRY)" = "$REG" ] || fail "GACHIPAD_REGISTRY not taken from the bundle"
ID="$(create_data marker-one)"
[ -n "$ID" ] || fail "no share id"
has_marker "$ID" marker-one || fail "no data"
ok "1.0.0 running with share $ID"

step "update.sh --check and an update to 1.0.1"
in_install ./update.sh --check | tee "$WORK/check.log"
grep -q 'installed 1.0.0, newest 1.0.2' "$WORK/check.log" || fail "--check"
in_install ./update.sh --version 1.0.1 --yes | tail -n 4
[ "$(envv GACHIPAD_VERSION)" = 1.0.1 ] || fail "not on 1.0.1"
in_install docker compose ps --format '{{.Service}} {{.Image}} {{.State}}' | tee "$WORK/ps.log"
grep -q "^api $REG/gachipad-api:1.0.1 running" "$WORK/ps.log" || fail "api does not run 1.0.1"
grep -q "^caddy $REG/gachipad-web:1.0.1 running" "$WORK/ps.log" || fail "caddy does not run 1.0.1"
curl -fsS "http://127.0.0.1:$P/readyz" >/dev/null || fail "/readyz"
has_marker "$ID" marker-one || fail "data lost in the update"
admin_update | tee "$WORK/admin.json" | head -c 400
echo
grep -q '"lastRun":{"at":"[^"]*","result":"updated","from":"1.0.0","to":"1.0.1"' "$WORK/admin.json" ||
  fail "the admin API does not show the run (state/ mount)"
grep -q '"status":"disabled"' "$WORK/admin.json" || fail "UPDATE_CHECK=off not honoured"
ok "1.0.1 pulled, digests checked, healthy, data kept, run visible in /api/admin/update"

step "1.0.2 changes DB then fails: concurrent accepted writes and shutdown flush survive rollback"
ID2="$(create_data marker-two)"
# Gate the image pull using an operator-side docker shim. A real API write is accepted during
# this gate, after downloads started and before maintenance. Everything else is real Docker.
mkdir "$WORK/bin"
REAL_DOCKER="$(command -v docker)"
export REAL_DOCKER VERIFY_GATE="$WORK/gate"
cat >"$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [[ " $* " == *' pull '* ]]; then
  touch "$VERIFY_GATE.started"
  while [ ! -e "$VERIFY_GATE.continue" ]; do sleep .05; done
fi
exec "$REAL_DOCKER" "$@"
DOCKER
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH" in_install ./update.sh --version 1.0.2 --yes >"$WORK/bad.log" 2>&1 &
updater=$!
for _ in $(seq 200); do [ -e "$WORK/gate.started" ] && break; sleep .1; done
[ -e "$WORK/gate.started" ] || fail "updater never reached pull gate"
ID3="$(create_data accepted-during-pull)"
[ -n "$ID3" ] || fail "API did not accept a write while preparing update"
touch "$WORK/gate.continue"
# Observe the actual destructive migration before rollback removes its evidence.
mutated=0
for _ in $(seq 60); do
  # shellcheck disable=SC2016 # credentials are read only inside our Mongo container
  if in_install docker compose exec -T mongo mongosh --quiet --eval '
    db.getSiblingDB("admin").auth("gachipad", process.env.MONGO_INITDB_ROOT_PASSWORD);
    const app = db.getSiblingDB("gachipad");
    print(app.update_failure_marker.countDocuments({}) > 0 && app.shares.countDocuments({}) === 0 ? "mutated" : "waiting");
  ' 2>/dev/null | grep -qx mutated; then mutated=1; break; fi
  sleep .1
done
[ "$mutated" = 1 ] || fail "did not observe the new API changing the DB"
if curl -fsS --max-time 1 "http://127.0.0.1:$P/healthz" >/dev/null 2>&1; then
  fail "ingress opened while the unverified API had changed the DB"
fi
ok "observed new collection and deleted shares with ingress closed, before rollback"
if wait "$updater"; then fail "update to a broken release succeeded"; fi
tail -n 8 "$WORK/bad.log"
grep -q 'rolling back to 1.0.1' "$WORK/bad.log" || fail "no rollback"
[ "$(envv GACHIPAD_VERSION)" = 1.0.1 ] || fail "version not rolled back"
curl -fsS "http://127.0.0.1:$P/readyz" >/dev/null || fail "1.0.1 not healthy after the rollback"
in_install docker compose ps --format '{{.Service}} {{.Image}}' | grep -q "^api $REG/gachipad-api:1.0.1$" || fail "api not on 1.0.1"
has_marker "$ID" marker-one || fail "first share lost in rollback"
has_marker "$ID2" marker-two || fail "second share lost in rollback"
has_marker "$ID3" accepted-during-pull || fail "accepted write during pull lost in rollback"
in_install docker compose logs api | grep -q 'old API refuses changed schema' && fail "old app ran before DB restore"
admin_update | grep -q '"result":"rolled-back","from":"1.0.1","to":"1.0.2"' || fail "rollback not in the admin API"
ok "1.0.2 mutated DB and failed; restore precedes old API startup; all three shares survive"

step "automatic updates (dry run on this host)"
in_install ./update.sh --enable-auto --at 04:00 --policy patch --dry-run

step "Linux mDNS install and optional service control"
VERIFY_MDNS_NETWORK_SUBNET=172.29.96.0/24 bash deploy/verify-mdns.sh "$WORK/deploy/dist/gachipad-1.0.1-linux-amd64.tar.gz" "$WORK/mdns-live" gp-dbdeploy-update-mdns

step "done"
echo "verify-update: all checks passed"
