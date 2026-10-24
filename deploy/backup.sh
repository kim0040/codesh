#!/usr/bin/env bash
# Dumps the codesh database (mongodump inside the mongo container) to <dir>/codesh-<time>.archive.gz.
#
#   ./backup.sh [dir]        default dir: ./backups
#
# Valkey only holds join codes, presence and caches; it is not part of the backup.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker

DIR="${1:-./backups}"
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/codesh-$(date +%Y%m%d-%H%M%S).archive.gz"

PART="$(mktemp "$DIR/.backup.XXXXXX")"
trap 'rm -f "$PART"' EXIT
docker compose exec -T mongo sh /opt/codesh/transfer.sh dump >"$PART"
[ -s "$PART" ] || { rm -f "$PART"; die "mongodump produced no data"; }
chmod 600 "$PART"
mv "$PART" "$FILE"
echo "backup: $FILE ($(wc -c <"$FILE" | tr -d ' ') bytes)"
