#!/usr/bin/env bash
# legacy codesh name (1.0.x); remove in 2.0
# Real published v1.0.1 bundle -> current branch, using the updater shipped in that bundle.
# Run through verify-update.sh --rename, on the box only. Every Docker resource is isolated.
set -euo pipefail
ROOT="$(pwd)"
WORK="${VERIFY_DIR:-/data/workspace/gp-upgrade-test}"
PROJECT="${VERIFY_PROJECT:-gp-upgrade-test}"
P="${VERIFY_HTTP_PORT:-18080}"
TLS_P="${VERIFY_HTTPS_PORT:-18443}"
REG_PORT="${VERIFY_REGISTRY_PORT:-5056}"
REG="localhost:$REG_PORT/rename-test"
TARGET=1.0.2
INSTALL="$WORK/install"
SERVER_PID=""
REGISTRY_STARTED=0
BUILDER_STARTED=0
BUILDER_VOLUME_STARTED=0
BUILDER_VOLUME="buildx_buildkit_${PROJECT}0_state"
REPORT="$ROOT/.box-out/rename2-real-upgrade.log"
mkdir -p "$ROOT/.box-out"
[ ! -e "$WORK" ] || { echo "$WORK already exists; choose a fresh VERIFY_DIR" >&2; exit 1; }
mkdir -p "$WORK" "$INSTALL" "$WORK/registry"
exec > >(tee "$REPORT") 2>&1

in_install() { (cd "$INSTALL" && COMPOSE_PROJECT_NAME="$PROJECT" "$@"); }
cleanup() {
  local status=$?
  trap - EXIT
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  if [ -f "$INSTALL/docker-compose.yml" ]; then
    in_install docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$REGISTRY_STARTED" = 1 ]; then
    docker rm -fv "$PROJECT-registry" >/dev/null 2>&1 || true
  fi
  if [ "$BUILDER_STARTED" = 1 ]; then docker buildx rm "$PROJECT" >/dev/null 2>&1 || true; fi
  if [ "$BUILDER_VOLUME_STARTED" = 1 ]; then docker volume rm "$BUILDER_VOLUME" >/dev/null 2>&1 || true; fi
  if [ "$REGISTRY_STARTED" = 1 ]; then
    docker run --rm --pull never -v "$WORK:/w" --entrypoint rm registry:2.8.3 -rf /w/registry /w/buildkit
  fi
  docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -F "$REG/" | xargs -r docker image rm -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "cleanup: isolated stack, volumes, registry, branch image tags and working files removed (status=$status)"
  exit "$status"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
envv() { sed -n "s/^$1=//p" "$INSTALL/.env" | tail -n 1; }
HEADER=X-Codesh
call() {
  local path="$1"; shift
  curl -fsS --max-time 30 -b "$WORK/jar" -c "$WORK/jar" -H 'Host: codesh.local' -H "$HEADER: 1" "$@" "http://127.0.0.1:$P$path"
}
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
volumes() {
  docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | sort |
    xargs -r docker volume inspect --format '{{.Name}} {{.CreatedAt}}'
}
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[ "$(df -Pk "$docker_root" | awk 'NR==2 {print int($4/1048576)}')" -ge 3 ] || fail 'need 3 GiB free in Docker root'

echo 'build: all four production Dockerfiles from a branch snapshot (synthetic next release 1.0.2)'
mkdir -p "$WORK/source"
tar --exclude=node_modules --exclude=.box-out --exclude=.git --exclude=dist --exclude=.turbo --exclude=playwright-report --exclude=test-results -cf - . |
  tar -xf - -C "$WORK/source"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const path = process.argv[1]; const data = JSON.parse(readFileSync(path));
  data.version = "1.0.2"; writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$WORK/source/package.json"
sed -i "s/^GACHIPAD_VERSION=.*/GACHIPAD_VERSION=$TARGET/" "$WORK/source/deploy/.env.example"
printf 'SESSION_SECRET=build\nCOLLAB_SECRET=build\nMONGO_PASSWORD=build\nMONGO_APP_PASSWORD=build\nVALKEY_PASSWORD=build\nGACHIPAD_VERSION=%s\nGACHIPAD_REGISTRY=%s\n' "$TARGET" "$REG" >"$WORK/build.env"
docker run -d --name "$PROJECT-registry" -p "127.0.0.1:$REG_PORT:5000" -v "$WORK/registry:/var/lib/registry" registry:2.8.3 >/dev/null
REGISTRY_STARTED=1
# BuildKit's dedicated state volume is bound to this owned /data directory, not the shared root.
mkdir "$WORK/buildkit"
if docker volume inspect "$BUILDER_VOLUME" >/dev/null 2>&1; then fail 'builder state volume already exists'; fi
docker volume create --driver local --opt type=none --opt "device=$WORK/buildkit" --opt o=bind "$BUILDER_VOLUME" >/dev/null
BUILDER_VOLUME_STARTED=1
docker buildx create --name "$PROJECT" --node "${PROJECT}0" --driver docker-container --driver-opt default-load=true,memory=3g >/dev/null
BUILDER_STARTED=1
for service in api collab caddy mdns; do
  [ "$(df -Pk "$docker_root" | awk 'NR==2 {print int($4/1048576)}')" -ge 2 ] || fail 'need 2 GiB free before the next build'
  BUILDX_BUILDER="$PROJECT" docker compose --env-file "$WORK/build.env" --profile mdns -f "$WORK/source/deploy/docker-compose.yml" build --build-arg "GACHIPAD_VERSION=$TARGET" "$service"
done
for name in api collab web mdns; do docker push -q "$REG/gachipad-$name:$TARGET" >/dev/null; done
(cd "$WORK/source/deploy" && BUNDLE_SOURCE=registry GACHIPAD_REGISTRY="$REG" BUNDLE_SUFFIX=-linux-amd64 bash bundle.sh "$TARGET")

echo 'install: official v1.0.1 offline bundle, unmodified updater and application images'
base=https://github.com/kim0040/gachipad/releases/download/v1.0.1
curl -fsSL --retry 2 "$base/codesh-1.0.1-linux-amd64.tar.gz" -o "$WORK/old.tar.gz"
curl -fsSL --retry 2 "$base/codesh-1.0.1-linux-amd64.tar.gz.sha256" -o "$WORK/old.sha256"
[ "$(sha256sum "$WORK/old.tar.gz" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$WORK/old.sha256")" ] || fail 'published old bundle checksum'
tar xzf "$WORK/old.tar.gz" -C "$INSTALL" --strip-components=1
cp "$INSTALL/.env.example" "$INSTALL/.env"
for setting in HTTP_PORT="$P" HTTPS_PORT="$TLS_P" SITE_ADDRESS=http://codesh.local NETWORK_SUBNET=172.29.99.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb UPDATE_CHECK=off; do
  sed -i "s|^${setting%%=*}=.*|$setting|" "$INSTALL/.env"
done
in_install ./install.sh
rm "$INSTALL/images.tar"
for name in api collab web; do
  docker tag "ghcr.io/kim0040/codesh-$name:1.0.1" "$REG/codesh-$name:1.0.1"
  docker push -q "$REG/codesh-$name:1.0.1" >/dev/null
done
old_updater="$(sha256sum "$INSTALL/update.sh" | cut -d' ' -f1)"
echo 'seed: guest ownership, signed session, user profile/identity, history, settings and upload'
call /api/session -X PATCH -H 'Content-Type: application/json' -d '{"name":"Upgrade fixture","color":"#112233"}' >"$WORK/session-before.json"
CLIENT="$(json_field clientId <"$WORK/session-before.json")"
ID="$(call /api/shares -H 'Content-Type: application/json' -d '{"title":"Upgrade fixture","files":[{"path":"main.txt","content":"preserved branch rename data"}]}' | json_field id)"
UPLOAD="$(call /api/uploads -F "file=@$INSTALL/VERSION;filename=fixture.txt" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["uploadId"])')"
call "/api/uploads/$UPLOAD" >"$WORK/upload-before"
call /api/admin/settings -H "Authorization: Bearer $(envv ADMIN_TOKEN)" >"$WORK/settings-before.json"
python3 -c 'import json,sys; d=json.load(sys.stdin); d["contact"]="upgrade fixture contact"; print(json.dumps(d))' <"$WORK/settings-before.json" >"$WORK/settings-put.json"
call /api/admin/settings -X PUT -H "Authorization: Bearer $(envv ADMIN_TOKEN)" -H 'Content-Type: application/json' --data-binary "@$WORK/settings-put.json" >/dev/null
call /api/admin/settings -H "Authorization: Bearer $(envv ADMIN_TOKEN)" >"$WORK/settings-before.json"
# shellcheck disable=SC2016 # credentials expand only inside the test container
in_install docker compose exec -T -e "VERIFY_CLIENT=$CLIENT" valkey sh -c '
  export REDISCLI_AUTH="$VALKEY_PASSWORD"
  valkey-cli HSET "identity:$VERIFY_CLIENT" provider oidc subject rename-fixture name "Upgrade fixture" >/dev/null
'
in_install docker compose exec -T -e "VERIFY_SHARE=$ID" mongo mongosh --quiet --eval '
  db.getSiblingDB("admin").auth("codesh", process.env.MONGO_INITDB_ROOT_PASSWORD);
  const app = db.getSiblingDB("codesh");
  const { _id, ...snapshot } = app.share_snapshots.findOne({ shareId: process.env.VERIFY_SHARE, kind: "compact" });
  app.share_snapshots.insertOne({ ...snapshot, kind: "history", seq: 7 });
' >/dev/null
call /api/session >"$WORK/session-before.json"
call "/api/shares/$ID/history" >"$WORK/history-before.json"
call "/api/shares/$ID/history/7" >"$WORK/history-before.bin"
volumes >"$WORK/volumes-before"

echo 'upgrade: v1.0.1 update.sh follows the old repo redirect and requests the legacy deploy asset'
srv="$WORK/srv"
dest="$srv/dl/kim0040/gachipad/releases/download/v$TARGET"
mkdir -p "$dest" "$srv/api/repos/kim0040/gachipad"
cp "$WORK/source/deploy/dist/codesh-deploy-$TARGET.tar.gz" "$dest/"
(cd "$dest" && sha256sum "codesh-deploy-$TARGET.tar.gz" >SHA256SUMS)
printf '[{"tag_name":"v%s","draft":false,"prerelease":false}]' "$TARGET" >"$srv/api/repos/kim0040/gachipad/releases"
cat >"$WORK/server.py" <<'PY'
import http.server, os, sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if '/kim0040/codesh/' in self.path:
            self.send_response(301)
            self.send_header('Location', self.path.replace('/kim0040/codesh/', '/kim0040/gachipad/'))
            self.end_headers()
        else:
            super().do_GET()
os.chdir(sys.argv[1])
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), Handler).serve_forever()
PY
server_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 "$WORK/server.py" "$srv" "$server_port" >"$WORK/requests.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do
  curl -fsS "http://127.0.0.1:$server_port/api/repos/kim0040/gachipad/releases" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail 'release fixture server exited'
  sleep .1
done
curl -fsS "http://127.0.0.1:$server_port/api/repos/kim0040/gachipad/releases" >/dev/null || fail 'release fixture server not ready'
# This mirrors an operator's registry setting. Both generations use the same mirror namespace.
sed -i "s|^CODESH_REGISTRY=.*|CODESH_REGISTRY=$REG|" "$INSTALL/.env"
[ "$(sha256sum "$INSTALL/update.sh" | cut -d' ' -f1)" = "$old_updater" ] || fail 'old updater changed before execution'
UPDATE_API_URL="http://127.0.0.1:$server_port/api" UPDATE_DOWNLOAD_URL="http://127.0.0.1:$server_port/dl" UPDATE_HEALTH_TIMEOUT=180 \
  in_install ./update.sh --version "$TARGET" --yes
grep -q 'codesh-deploy-1.0.2.tar.gz.*301' "$WORK/requests.log" || fail 'legacy filename/redirect not exercised'
HEADER=X-Gachipad
volumes >"$WORK/volumes-after"
cmp "$WORK/volumes-before" "$WORK/volumes-after" || fail 'volumes were replaced'
[ "$(envv GACHIPAD_VERSION)" = "$TARGET" ] || fail 'new version missing'
[ "$(envv MONGO_DATABASE)" = codesh ] || fail 'old database not pinned'
[ "$(envv MDNS_HOSTNAME)" = gachipad.local ] || fail 'new mDNS default missing'
[ "$(envv MDNS_ALIASES)" = codesh.local ] || fail 'old mDNS alias missing'
curl -fsS --max-time 10 -H 'Host: gachipad.local' "http://127.0.0.1:$P/healthz" >/dev/null || fail 'new hostname not served after upgrade'
call /api/session >"$WORK/session-after.json"
cmp "$WORK/session-before.json" "$WORK/session-after.json" || fail 'session/profile/identity changed'
grep -q gachipad_sid "$WORK/jar" || fail 'new cookie not reissued'
call "/api/shares/$ID/history" >"$WORK/history-after.json"
cmp "$WORK/history-before.json" "$WORK/history-after.json" || fail 'history/guest ownership changed'
call "/api/shares/$ID/history/7" >"$WORK/history-after.bin"
cmp "$WORK/history-before.bin" "$WORK/history-after.bin" || fail 'history state changed'
call "/api/uploads/$UPLOAD" >"$WORK/upload-after"
cmp "$WORK/upload-before" "$WORK/upload-after" || fail 'upload changed'
call /api/admin/settings -H "Authorization: Bearer $(envv ADMIN_TOKEN)" >"$WORK/settings-after.json"
cmp "$WORK/settings-before.json" "$WORK/settings-after.json" || fail 'admin settings changed'
call "/api/shares/$ID/download" -o "$WORK/share.zip"
unzip -p "$WORK/share.zip" | grep -q 'preserved branch rename data' || fail 'share text missing'
in_install ./backup.sh "$WORK/backups"
backup="$(find "$WORK/backups" -name '*.archive.gz' -type f | head -n1)"
in_install ./restore.sh "$backup" --yes
call "/api/shares/$ID/history/7" >"$WORK/history-restored.bin"
cmp "$WORK/history-before.bin" "$WORK/history-restored.bin" || fail 'renamed backup/restore lost history'
echo 'PASS: same volumes, share content, guest ownership, session, profile/identity, history bytes, settings, upload, backup/restore'

echo 'offline: original 1.0.1 upgrader, with bundle images from a different registry'
in_install docker compose down -v --remove-orphans
rm -rf "$INSTALL"
mkdir "$INSTALL"
tar xzf "$WORK/old.tar.gz" -C "$INSTALL" --strip-components=1
cp "$INSTALL/.env.example" "$INSTALL/.env"
for setting in HTTP_PORT="$P" HTTPS_PORT="$TLS_P" SITE_ADDRESS=http://codesh.local NETWORK_SUBNET=172.29.99.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb UPDATE_CHECK=off; do
  sed -i "s|^${setting%%=*}=.*|$setting|" "$INSTALL/.env"
done
in_install ./install.sh
HEADER=X-Codesh
rm -f "$WORK/jar"
OFFLINE_ID="$(call /api/shares -H 'Content-Type: application/json' -d '{"title":"Offline fixture","files":[{"path":"main.txt","content":"offline registry data"}]}' | json_field id)"
volumes >"$WORK/offline-volumes-before"
in_install ./upgrade.sh "$WORK/source/deploy/dist/gachipad-$TARGET-linux-amd64.tar.gz"
HEADER=X-Gachipad
[ "$(envv GACHIPAD_REGISTRY)" = "$REG" ] || fail 'offline registry not taken from bundle'
volumes >"$WORK/offline-volumes-after"
cmp "$WORK/offline-volumes-before" "$WORK/offline-volumes-after" || fail 'offline volumes replaced'
call "/api/shares/$OFFLINE_ID/download" -o "$WORK/offline.zip"
unzip -p "$WORK/offline.zip" | grep -q 'offline registry data' || fail 'offline share ownership/content lost'
echo 'PASS: unmodified 1.0.1 offline upgrader accepts the renamed bundle and its different registry; data and volumes preserved'

echo 'fresh: new bundle defaults, Mongo users/database, images and state mount use gachipad'
in_install docker compose down -v --remove-orphans
rm -rf "$INSTALL"
mkdir "$INSTALL"
tar xzf "$WORK/source/deploy/dist/gachipad-$TARGET-linux-amd64.tar.gz" -C "$INSTALL" --strip-components=1
cp "$INSTALL/.env.example" "$INSTALL/.env"
for setting in HTTP_PORT="$P" HTTPS_PORT="$TLS_P" NETWORK_SUBNET=172.29.99.0/24 MONGO_CACHE_GB=0.25 VALKEY_MAXMEMORY=256mb UPDATE_CHECK=off; do
  sed -i "s|^${setting%%=*}=.*|$setting|" "$INSTALL/.env"
done
in_install ./install.sh
! grep -qi codesh "$INSTALL/.env" || fail 'legacy name in fresh .env'
in_install docker compose config >"$WORK/fresh-config"
! grep -qi codesh "$WORK/fresh-config" || fail 'legacy name in fresh compose config'
in_install docker compose exec -T api node --input-type=module -e '
  import { MongoClient } from "mongodb";
  const client = await MongoClient.connect(process.env.MONGO_URL);
  const { authInfo } = await client.db().command({ connectionStatus: 1 });
  if (client.db().databaseName !== "gachipad" || authInfo.authenticatedUsers[0].user !== "gachipad_app") process.exit(1);
  await client.close();
'
echo 'restore: legacy backup into a fresh gachipad database'
in_install ./restore.sh "$backup" --yes
in_install docker compose exec -T -e "VERIFY_SHARE=$ID" mongo mongosh --quiet --eval '
  db.getSiblingDB("admin").auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
  const app = db.getSiblingDB("gachipad");
  if (!app.shares.findOne({ _id: process.env.VERIFY_SHARE })) throw new Error("legacy share not restored");
  if (app.share_snapshots.countDocuments({ shareId: process.env.VERIFY_SHARE, kind: "history", seq: 7 }) !== 1) throw new Error("legacy history not restored");
  if (app.getCollection("uploads.files").countDocuments({}) !== 1) throw new Error("legacy upload not restored");
  if (app.settings.findOne({ _id: "global" }).contact !== "upgrade fixture contact") throw new Error("legacy settings not restored");
  if (db.getSiblingDB("codesh").getCollectionNames().length !== 0) throw new Error("legacy database recreated on fresh install");
'
echo 'PASS: legacy archive restores shares, history, uploads and settings into only the fresh gachipad namespace'
echo 'verify-rename: all checks passed'
