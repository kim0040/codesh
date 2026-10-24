#!/usr/bin/env bash
# Upgrades an installed codesh to a newer offline bundle. Backs up the database first and keeps .env.
#
#   ./upgrade.sh codesh-<new version>.tar.gz
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh

upgrade() {
  need_docker
  local bundle="${1:-}"
  [ -n "$bundle" ] && [ -f "$bundle" ] || die "usage: ./upgrade.sh <bundle.tar.gz>"
  [ -f .env ] || die "no .env here: this is not an installed codesh"

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar xzf "$bundle" -C "$tmp"
  local src
  src="$(find "$tmp" -maxdepth 2 -name images.tar -exec dirname {} \; | head -n 1)"
  [ -n "$src" ] || die "$bundle is not a codesh bundle"
  local version
  version="$(cat "$src/VERSION")"

  echo "upgrade: $(env_get CODESH_VERSION) -> $version"
  ./backup.sh ./backups
  docker load -i "$src/images.tar"
  for file in docker-compose.yml .env.example VERSION lib.sh lib.ps1 generate-secrets.sh generate-secrets.ps1 install.sh install.ps1 upgrade.sh upgrade.ps1 backup.sh backup.ps1 restore.sh restore.ps1 README.md; do
    # A new inode, so the running script is not overwritten in place.
    [ -f "$src/$file" ] && cp "$src/$file" "./$file.new" && mv "./$file.new" "./$file"
  done
  mkdir -p tls && cp -n "$src"/tls/* tls/ 2>/dev/null || true
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
