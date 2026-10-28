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
trap install_unlock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
install_lock
case "$action" in
  enable)
    if ! mdns_supported; then
      echo 'mdns: disabled; a native Linux Docker host is required for multicast host networking.'
      exit 1
    fi
    select_mdns 1
    docker compose --profile mdns up -d --no-deps --force-recreate mdns
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
