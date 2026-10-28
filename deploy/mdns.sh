#!/usr/bin/env bash
# Manage the optional LAN name of an existing installation, without restarting app services.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
case "${1:-}" in enable | disable | status) action="$1" ;; *) die 'usage: ./mdns.sh enable|disable|status' ;; esac
[ "$#" = 1 ] || die 'usage: ./mdns.sh enable|disable|status'
[ -f .env ] || die '.env is missing; run install.sh first'
need_docker
SNAPSHOT=""
COMMITTED=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM PIPE
  if [ -n "$SNAPSHOT" ]; then
    if [ "$COMMITTED" = 0 ]; then
      docker compose --profile mdns stop mdns >/dev/null 2>&1 || true
      if ! cp -p "$SNAPSHOT" .env.mdns-recovery || ! mv .env.mdns-recovery .env; then
        echo "mdns: could not restore .env; original kept at $SNAPSHOT" >&2
        install_unlock
        exit 1
      fi
    fi
    rm -f "$SNAPSHOT"
  fi
  install_unlock
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$action" = status ] || install_lock
case "$action" in
  enable)
    if ! mdns_supported; then
      echo 'mdns: disabled; a native Linux Docker host is required for multicast host networking.'
      exit 1
    fi
    mdns_require_image
    SNAPSHOT="$(mktemp .env.mdns-snapshot.XXXXXX)"
    if ! cp -p .env "$SNAPSHOT"; then
      rm -f "$SNAPSHOT"; SNAPSHOT=""
      die 'could not snapshot .env; settings unchanged'
    fi
    select_mdns 1
    docker compose --profile mdns up -d --wait --wait-timeout 15 --pull never --no-deps --force-recreate mdns
    COMMITTED=1
    mdns_addresses
    ;;
  disable)
    docker compose --profile mdns stop mdns
    mdns_profile 0
    echo 'mdns: disabled'
    ;;
  status)
    if mdns_enabled; then echo "mdns: enabled ($(env_get MDNS_HOSTNAME gachipad.local))"
    else echo 'mdns: disabled'; fi
    docker compose --profile mdns ps mdns
    ;;
esac
