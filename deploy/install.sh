#!/usr/bin/env bash
# Installs gachipad from an offline bundle: loads the images, creates .env with fresh secrets and
# starts the stack. Needs docker with the compose plugin; no internet.
#
#   tar xzf gachipad-<version>.tar.gz && cd gachipad-<version> && ./install.sh
#   PUBLIC_URL=http://gachipad.local HTTP_PORT=8080 ./install.sh     # optional settings for a new .env
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker
verify_bundle .

[ -f images.tar ] || die "images.tar is missing: run this from the extracted bundle"
VERSION="$(cat VERSION)"

# legacy codesh name (1.0.x); remove in 2.0
# A 1.0.x installation keeps its data in codesh_* volumes. A folder without its .env would start an
# empty gachipad project next to them, so stop unless the operator named a project or opted in.
if [ ! -f .env ] && [ -z "${COMPOSE_PROJECT_NAME:-}${GACHIPAD_PROJECT:-}${GACHIPAD_NEW_INSTALL:-}" ] &&
  grep -qx codesh_mongo-data < <(docker volume ls -q); then
  die "the volumes of a codesh 1.0.x installation (codesh_mongo-data) exist on this host, but this folder has no .env. Update that installation in its own folder (./update.sh, or ./upgrade.sh <bundle>), or copy its .env here and run ./generate-secrets.sh .env first to keep its data. For a separate new installation set GACHIPAD_NEW_INSTALL=1."
fi

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
./generate-secrets.sh .env
env_set GACHIPAD_VERSION "$VERSION"
# The loaded images carry the bundle's registry in their names.
REGISTRY="$(sed -n 's/^GACHIPAD_REGISTRY=//p' .env.example | tail -n 1)"
[ -n "$REGISTRY" ] && env_set GACHIPAD_REGISTRY "$REGISTRY"
mkdir -p state && chmod 755 state

echo "install: starting"
docker compose up -d --wait
wait_healthy 120
echo "install: gachipad $VERSION is running on port $(env_get HTTP_PORT 80)"
echo "install: back up with ./backup.sh, update with ./update.sh (online) or ./upgrade.sh <new bundle>"
