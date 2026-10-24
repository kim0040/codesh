#!/usr/bin/env bash
# Restores a backup made by backup.sh. Replaces the current database contents.
#
#   ./restore.sh <archive.gz> [--yes]
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker
install_lock
trap install_unlock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] || die "usage: ./restore.sh <archive.gz> [--yes]"
[ -f "$ARCHIVE" ] || die "usage: ./restore.sh <archive.gz> [--yes]"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "Replace the current codesh database with $ARCHIVE? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "cancelled"
fi

# api and collab write to the database; collab flushes open documents on stop.
stop_writes
docker compose up -d --wait --wait-timeout 120 mongo valkey
mongo_transfer restore <"$ARCHIVE"
docker compose up -d --wait --wait-timeout 120 mongo mongo-users valkey api collab
wait_api 120
docker compose up -d --wait --wait-timeout 120
echo "restore: done"
