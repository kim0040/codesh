#!/usr/bin/env bash
# legacy codesh name (1.0.x); remove in 2.0
# The new helper is invoked by the installed v1.0.1 updater before starting the new compose file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT/generate-secrets.sh" "$ROOT/.env.example" "$WORK/"
cd "$WORK"
cat >.env <<'ENV'
CODESH_VERSION=1.0.2
CODESH_REGISTRY=ghcr.io/custom
SESSION_SECRET=keep-session
COLLAB_SECRET=keep-collab
MONGO_PASSWORD=keep-root
MONGO_APP_PASSWORD=keep-app
VALKEY_PASSWORD=keep-valkey
ADMIN_TOKEN=keep-admin
MDNS_HOSTNAME=codesh.local
SITE_ADDRESS=https://codesh.local
ENV
bash generate-secrets.sh >/dev/null
for setting in GACHIPAD_VERSION=1.0.2 GACHIPAD_REGISTRY=ghcr.io/custom GACHIPAD_PROJECT=codesh MONGO_ROOT_USER=codesh MONGO_APP_USER=codesh_app MONGO_DATABASE=codesh MDNS_HOSTNAME=gachipad.local MDNS_ALIASES=codesh.local SITE_ADDRESS=https://codesh.local 'SITE_ALIASES=, gachipad.local' SESSION_SECRET=keep-session; do
  grep -qxF "$setting" .env || { echo "missing $setting" >&2; exit 1; }
done
cp .env before.env
bash generate-secrets.sh >/dev/null
cmp .env before.env
# Offline bundles may come from a different registry than the operator's old mirror.
sed -i '/^GACHIPAD_LEGACY_INSTALL=/d' .env
touch images.tar
bash generate-secrets.sh >/dev/null
grep -qx 'GACHIPAD_REGISTRY=ghcr.io/kim0040' .env
grep -qx 'CODESH_REGISTRY=ghcr.io/custom' .env
rm images.tar
cp before.env .env
sed -i '/^GACHIPAD_LEGACY_INSTALL=/d;s/^MDNS_HOSTNAME=.*/MDNS_HOSTNAME=custom.local/; /^MDNS_ALIASES=/d' .env
bash generate-secrets.sh >/dev/null
grep -qx 'MDNS_HOSTNAME=custom.local' .env
if grep -q '^MDNS_ALIASES=' .env; then exit 1; fi
rm .env
bash generate-secrets.sh >/dev/null
if grep -qi codesh .env; then exit 1; fi
mkdir -p release/dist
for name in deploy-1.0.2 1.0.2-linux-amd64 1.0.2-linux-arm64 web-sourcemaps-1.0.2; do
  printf 'fixture %s\n' "$name" >"release/dist/gachipad-$name.tar.gz"
done
# Execute the release workflow's exact compatibility step against small local fixtures.
sed -n '/for asset in dist\/gachipad-/,/^[[:space:]]*done$/p' "$ROOT/../.github/workflows/release.yml" >release/aliases.sh
(cd release && bash aliases.sh)
(cd release/dist && sha256sum -c codesh-*.sha256)
echo 'rename migration: 5 scenarios passed (legacy locations, secrets, idempotence, offline registry, custom/fresh names)'
echo 'release aliases: deploy, amd64, arm64 and source maps match their new assets and checksums'
