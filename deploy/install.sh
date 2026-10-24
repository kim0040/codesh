#!/usr/bin/env bash
# Installs codesh from an offline bundle: loads the images, creates .env with fresh secrets and
# starts the stack. Needs docker with the compose plugin; no internet.
#
#   tar xzf codesh-<version>.tar.gz && cd codesh-<version> && ./install.sh
#   PUBLIC_URL=http://codesh.corp HTTP_PORT=8080 ./install.sh     # optional settings for a new .env
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
need_docker

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
./generate-secrets.sh .env

echo "install: starting"
docker compose up -d --wait
wait_healthy 120
echo "install: codesh $VERSION is running on port $(env_get HTTP_PORT 80)"
echo "install: back up with ./backup.sh, upgrade with ./upgrade.sh <new bundle>"
