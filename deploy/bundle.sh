#!/usr/bin/env bash
# Packs the images with the compose file and the admin scripts into one tar.gz for a host without
# internet (install with install.sh inside the archive), and the same files without
# the images into gachipad-deploy-<version>.tar.gz, which update.sh fetches on hosts that pull images.
#
#   deploy/bundle.sh [version]                     builds the images from this tree
#   BUNDLE_SOURCE=registry deploy/bundle.sh 1.2.3  pulls the released images instead (release.yml)
#   BUNDLE_SUFFIX=-linux-arm64                     is appended to the offline bundle's name
#   GACHIPAD_REGISTRY=ghcr.io/<owner>                image names (default ghcr.io/kim0040)
#
#   -> deploy/dist/gachipad-<version><suffix>.tar.gz and gachipad-deploy-<version>.tar.gz (+ .sha256)
#
# Runs where docker and internet access are available.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
need_docker

VERSION="${1:-$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' ../package.json)}"
VERSION="$(printf '%s' "$VERSION" | tr -c 'A-Za-z0-9._-' '-')"
[ -n "$VERSION" ] || die "no version given and none in package.json"
SOURCE="${BUNDLE_SOURCE:-build}"
REGISTRY="${GACHIPAD_REGISTRY:-ghcr.io/kim0040}"
NAME="gachipad-$VERSION${BUNDLE_SUFFIX:-}"
DEPLOY_NAME="gachipad-deploy-$VERSION"
STAGE="dist/$NAME"
# GitHub refuses release assets of 2 GiB or more.
MAX_BYTES=$((2 * 1024 * 1024 * 1024 - 1))

# Compose needs values for the required secrets even to build; these are throwaway.
BUILD_ENV="$(mktemp)"
trap 'rm -f "$BUILD_ENV"' EXIT
cat >"$BUILD_ENV" <<ENV
SESSION_SECRET=build
COLLAB_SECRET=build
MONGO_PASSWORD=build
MONGO_APP_PASSWORD=build
POSTGRES_PASSWORD=build
VALKEY_PASSWORD=build
GACHIPAD_VERSION=$VERSION
GACHIPAD_REGISTRY=$REGISTRY
GACHIPAD_DB=sqlite
GACHIPAD_DATABASE_URL=sqlite:///data/gachipad.db
ENV
compose() { docker compose --env-file "$BUILD_ENV" --profile mdns --profile mongodb --profile postgres -f docker-compose.yml "$@"; }
GACHIPAD_SERVICES="api collab caddy mdns"

case "$SOURCE" in
  build)
    echo "bundle: building gachipad $VERSION"
    compose build
    compose pull mongo mongo-users postgres valkey
    ;;
  registry)
    echo "bundle: pulling gachipad $VERSION from $REGISTRY"
    # shellcheck disable=SC2086
    compose pull $GACHIPAD_SERVICES mongo mongo-users postgres valkey
    ;;
  *) die "BUNDLE_SOURCE must be build or registry" ;;
esac

# shellcheck disable=SC2094 # SHA256SUMS is explicitly excluded from the input list.
sums() { (cd "$1" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS); }
archive() {
  tar czf "dist/$1.tar.gz" -C dist "$NAME"
  (cd dist && { sha256sum "$1.tar.gz" 2>/dev/null || shasum -a 256 "$1.tar.gz"; } >"$1.tar.gz.sha256")
}

rm -rf "$STAGE"
mkdir -p "$STAGE/tls" "$STAGE/docs" "$STAGE/state"
# The installed copy has no sources: drop the build sections, keep the image names.
awk '
  /^    build:/ { skip = 1; next }
  skip && /^      / { next }
  { skip = 0; print }
' docker-compose.yml >"$STAGE/docker-compose.yml"
sed -e "s/^GACHIPAD_VERSION=.*/GACHIPAD_VERSION=$VERSION/" -e "s|^GACHIPAD_REGISTRY=.*|GACHIPAD_REGISTRY=$REGISTRY|" \
  .env.example >"$STAGE/.env.example"
cp lib.sh generate-secrets.sh install.sh upgrade.sh update.sh backup.sh restore.sh "$STAGE/"
touch "$STAGE/state/.gitkeep"
cp tls/README.md tls/*.example "$STAGE/tls/"
cp ../docs/OPERATIONS.md ../docs/ARCHITECTURE.md ../CHANGELOG.md "$STAGE/docs/"
[ -f README.md ] && cp README.md "$STAGE/"
cp ../LICENSE ../THIRD_PARTY_NOTICES.md "$STAGE/"
printf '%s\n' "$VERSION" >"$STAGE/VERSION"

# Pulled images have registry digests: update.sh checks that it pulls exactly these, also from a
# mirror that keeps them. One line per image: <name> sha256:<digest>.
if [ "$SOURCE" = registry ]; then
  # The names of docker-compose.yml (`config --images <service>` also lists the dependencies).
  for name in gachipad-api gachipad-collab gachipad-web gachipad-mdns; do
    ref="$REGISTRY/$name:$VERSION"
    digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" |
      grep -m 1 "^$REGISTRY/$name@sha256:")" || die "no registry digest for $ref"
    printf '%s %s\n' "$name" "${digest##*@}" >>"$STAGE/IMAGES"
  done
fi

# Without images first: the online update archive.
sums "$STAGE"
archive "$DEPLOY_NAME"
# legacy codesh name (1.0.x); remove in 2.0
# The already-installed 1.0.1 updater requests this exact filename, then reads the NEW compose.
cp "dist/$DEPLOY_NAME.tar.gz" "dist/codesh-deploy-$VERSION.tar.gz"
(cd dist && sha256sum "codesh-deploy-$VERSION.tar.gz" >"codesh-deploy-$VERSION.tar.gz.sha256")

IMAGES="$(compose config --images | sort -u)"
echo "bundle: saving $(echo "$IMAGES" | tr '\n' ' ')"
# shellcheck disable=SC2086
docker save $IMAGES -o "$STAGE/images.tar"
sums "$STAGE"
archive "$NAME"
rm -rf "$STAGE"

size="$(wc -c <"dist/$NAME.tar.gz" | tr -d ' ')"
[ "$size" -le "$MAX_BYTES" ] || die "dist/$NAME.tar.gz is $size bytes, over the 2 GiB release asset limit"
echo "bundle: dist/$NAME.tar.gz ($(du -h "dist/$NAME.tar.gz" | cut -f1)), dist/$DEPLOY_NAME.tar.gz"
