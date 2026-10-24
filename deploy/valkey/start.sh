#!/bin/sh
# Keep the password out of valkey-server's argv. The normal image entrypoint still drops privileges.
set -eu
umask 077
conf=$(mktemp /tmp/codesh-valkey.XXXXXX)
case "$VALKEY_PASSWORD" in
  *'
'*|*'
'*) echo 'VALKEY_PASSWORD must be a single line' >&2; exit 1 ;;
esac
escaped=$(printf '%s' "$VALKEY_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'requirepass "%s"\nappendonly yes\nmaxmemory %s\nmaxmemory-policy noeviction\n' "$escaped" "${VALKEY_MAXMEMORY:-1gb}" >"$conf"
chown valkey:valkey "$conf"
exec docker-entrypoint.sh valkey-server "$conf"
