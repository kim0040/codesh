#!/usr/bin/env bash
# Upgrades an installed codesh to a newer offline bundle. Backs up the database first and keeps .env.
#
#   ./upgrade.sh codesh-<new version>.tar.gz
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh

upgrade_tmp=""

upgrade() {
  need_docker
  local bundle="${1:-}"
  [ -n "$bundle" ] && [ -f "$bundle" ] || die "usage: ./upgrade.sh <bundle.tar.gz>"
  [ -f .env ] || die "no .env here: this is not an installed codesh"

  verify_archive "$bundle"

  upgrade_tmp="$(mktemp -d)"
  trap 'rm -rf "$upgrade_tmp"' EXIT
  tar xzf "$bundle" -C "$upgrade_tmp"
  local src
  src="$(find "$upgrade_tmp" -maxdepth 2 -name images.tar -exec dirname {} \; | head -n 1)"
  [ -n "$src" ] || die "$bundle is not a codesh bundle"
  verify_bundle "$src"
  local version
  version="$(cat "$src/VERSION")"

  echo "upgrade: $(env_get CODESH_VERSION) -> $version"
  ./backup.sh ./backups
  docker load -i "$src/images.tar"
  for file in docker-compose.yml .env.example VERSION lib.sh generate-secrets.sh install.sh upgrade.sh backup.sh restore.sh README.md; do
    # A new inode, so the running script is not overwritten in place.
    [ -f "$src/$file" ] && cp "$src/$file" "./$file.new" && mv "./$file.new" "./$file"
  done
  mkdir -p docs && cp "$src"/docs/* docs/ 2>/dev/null || true
  mkdir -p tls && cp -n "$src"/tls/*.example tls/ 2>/dev/null || true
  env_set CODESH_VERSION "$version"
  # Secrets and settings added by the new version are filled in; existing values stay.
  for name in $(sed -n 's/^\([A-Z_]*\)=.*/\1/p' .env.example); do
    grep -q "^$name=" .env || sed -n "s/^$name=.*/&/p" .env.example >>.env
  done
  ./generate-secrets.sh .env
  docker compose up -d --wait
  wait_healthy 120
  echo "upgrade: codesh $version is running"
}

# The script file is replaced while it runs; bash must not read on after this line.
upgrade "$@"; exit $?
