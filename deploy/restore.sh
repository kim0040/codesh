#!/usr/bin/env bash
# Restores a backup made by backup.sh. Replaces the current database contents.
#
#   ./restore.sh <archive.gz> [--yes]
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "usage: ./restore.sh <archive.gz> [--yes]"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "Replace the current codesh database with $ARCHIVE? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "cancelled"
fi

# api and collab write to the database; collab flushes open documents on stop.
docker compose stop api collab
docker compose exec -T mongo sh /opt/codesh/transfer.sh restore <"$ARCHIVE"
docker compose start api collab
wait_healthy 120
echo "restore: done"
