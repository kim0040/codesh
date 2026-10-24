#!/usr/bin/env bash
# Dumps the codesh database (mongodump inside the mongo container) to <dir>/codesh-<time>.archive.gz.
#
#   ./backup.sh [dir]        default dir: ./backups
#
# Valkey (join codes, presence, grants, bans, counters) is not part of the backup. The archive holds
# edit keys, PIN hashes and addresses: it is written 0600 into a directory created 0700.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
need_docker

DIR="${1:-./backups}"
[ -d "$DIR" ] || mkdir -p -m 700 "$DIR"
FILE="$DIR/codesh-$(date +%Y%m%d-%H%M%S).archive.gz"

PART="$(mktemp "$DIR/.backup.XXXXXX")"
trap 'rm -f "$PART"' EXIT
mongo_transfer dump >"$PART"
[ -s "$PART" ] || { rm -f "$PART"; die "mongodump produced no data"; }
chmod 600 "$PART"
mv "$PART" "$FILE"
echo "backup: $FILE ($(wc -c <"$FILE" | tr -d ' ') bytes)"
