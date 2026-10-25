#!/usr/bin/env bash
# Installs gachipad from an offline bundle: loads the images, creates .env with fresh secrets and
# starts the stack. Needs docker with the compose plugin; no internet.
#
#   tar xzf codesh-<version>.tar.gz && cd codesh-<version> && ./install.sh
#   PUBLIC_URL=http://codesh.local HTTP_PORT=8080 ./install.sh     # optional settings for a new .env
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker
verify_bundle .

[ -f images.tar ] || die "images.tar is missing: run this from the extracted bundle"
VERSION="$(cat VERSION)"

echo "install: loading images ($VERSION)"
docker load -i images.tar

if [ -f .env ]; then
  echo "install: keeping the existing .env"
else
  cp .env.example .env
  for name in PUBLIC_URL HTTP_PORT HTTPS_PORT SITE_ADDRESS COLLAB_REPLICAS; do
    value="${!name:-}"
    [ -n "$value" ] && env_set "$name" "$value"
  done
fi
env_set CODESH_VERSION "$VERSION"
# The loaded images carry the bundle's registry in their names.
REGISTRY="$(sed -n 's/^CODESH_REGISTRY=//p' .env.example | tail -n 1)"
[ -n "$REGISTRY" ] && env_set CODESH_REGISTRY "$REGISTRY"
mkdir -p state && chmod 755 state
./generate-secrets.sh .env

echo "install: starting"
docker compose up -d --wait
wait_healthy 120
echo "install: gachipad $VERSION is running on port $(env_get HTTP_PORT 80)"
echo "install: back up with ./backup.sh, update with ./update.sh (online) or ./upgrade.sh <new bundle>"
