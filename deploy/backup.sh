#!/usr/bin/env bash
# Dumps the codesh database (mongodump inside the mongo container) to <dir>/codesh-<time>.archive.gz.
#
#   ./backup.sh [dir]        default dir: ./backups
#
# Valkey only holds join codes, presence and caches; it is not part of the backup.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh
need_docker

DIR="${1:-./backups}"
mkdir -p "$DIR"
FILE="$DIR/codesh-$(date +%Y%m%d-%H%M%S).archive.gz"

docker compose exec -T mongo sh -c \
  'mongodump --quiet --uri "mongodb://codesh:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/codesh?authSource=admin" --archive --gzip' \
  >"$FILE.part"
[ -s "$FILE.part" ] || { rm -f "$FILE.part"; die "mongodump produced no data"; }
mv "$FILE.part" "$FILE"
echo "backup: $FILE ($(wc -c <"$FILE" | tr -d ' ') bytes)"
