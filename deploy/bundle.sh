#!/usr/bin/env bash
# Builds every image and packs them with the compose file and the admin scripts into one tar.gz
# for a host without internet (docs/PLAN.md 8; install with install.sh inside the archive).
#
#   deploy/bundle.sh [version]        -> deploy/dist/codesh-<version>.tar.gz (+ .sha256)
#
# Runs where docker and internet access are available (the instabox dev box: scripts/box deploy/bundle.sh).
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
need_docker

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d%H%M)}"
VERSION="$(printf '%s' "$VERSION" | tr -c 'A-Za-z0-9._-' '-')"
NAME="codesh-$VERSION"
STAGE="dist/$NAME"

# Compose needs values for the required secrets even to build; these are throwaway.
BUILD_ENV="$(mktemp)"
trap 'rm -f "$BUILD_ENV"' EXIT
cat >"$BUILD_ENV" <<ENV
SESSION_SECRET=build
COLLAB_SECRET=build
MONGO_PASSWORD=build
VALKEY_PASSWORD=build
CODESH_VERSION=$VERSION
ENV
compose() { docker compose --env-file "$BUILD_ENV" --profile mdns -f docker-compose.yml "$@"; }

echo "bundle: building codesh $VERSION"
compose build
compose pull mongo valkey

rm -rf "$STAGE"
mkdir -p "$STAGE/tls" "$STAGE/mongo" "$STAGE/valkey" "$STAGE/docs"
IMAGES="$(compose config --images | sort -u)"
echo "bundle: saving $(echo "$IMAGES" | tr '\n' ' ')"
# shellcheck disable=SC2086
docker save $IMAGES -o "$STAGE/images.tar"

# The installed copy has no sources: drop the build sections, keep the image tags.
awk '
  /^    build:/ { skip = 1; next }
  skip && /^      / { next }
  { skip = 0; print }
' docker-compose.yml >"$STAGE/docker-compose.yml"
sed "s/^CODESH_VERSION=.*/CODESH_VERSION=$VERSION/" .env.example >"$STAGE/.env.example"
cp lib.sh generate-secrets.sh install.sh upgrade.sh backup.sh restore.sh "$STAGE/"
cp tls/README.md tls/*.example "$STAGE/tls/"
cp mongo/* "$STAGE/mongo/"
cp valkey/* "$STAGE/valkey/"
cp ../docs/OPERATIONS.md ../docs/ARCHITECTURE.md "$STAGE/docs/"
[ -f README.md ] && cp README.md "$STAGE/"
printf '%s\n' "$VERSION" >"$STAGE/VERSION"

(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS)

OUT="dist/$NAME.tar.gz"
tar czf "$OUT" -C dist "$NAME"
rm -rf "$STAGE"
(cd dist && { sha256sum "$NAME.tar.gz" 2>/dev/null || shasum -a 256 "$NAME.tar.gz"; } >"$NAME.tar.gz.sha256")
echo "bundle: $OUT ($(du -h "$OUT" | cut -f1))"
