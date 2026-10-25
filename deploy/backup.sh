#!/usr/bin/env bash
# Dumps the gachipad database (mongodump inside the mongo container) to <dir>/gachipad-<time>.archive.gz.
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
install_lock
trap install_unlock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mongo_backup "${1:-./backups}"
