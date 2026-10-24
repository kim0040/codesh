#!/usr/bin/env bash
# Offline upgrades use the same transaction, maintenance boundary and rollback as online updates.
#   ./upgrade.sh codesh-<new version>.tar.gz [--allow-major]
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
install_lock
trap install_unlock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
BUNDLE="${1:?usage: ./upgrade.sh <bundle.tar.gz> [--allow-major]}"
shift
[ -f ./update.sh ] || die "update.sh is missing after a legacy upgrade; copy it from the verified bundle of the installed version (OPERATIONS 15.5)"
# The child inherits the installation lock; the wrapper releases the mkdir fallback on exit.
./update.sh --bundle "$BUNDLE" "$@"
