#!/usr/bin/env bash
# Fills the empty secrets of an env file with random values; values that are already set stay.
#
#   ./generate-secrets.sh            # creates .env from .env.example if missing, then fills it
#   ./generate-secrets.sh path/.env  # fills that file
set -euo pipefail
umask 077

cd "$(dirname "$0")"
FILE="${1:-.env}"
SECRETS=(SESSION_SECRET COLLAB_SECRET ADMIN_TOKEN MONGO_PASSWORD MONGO_APP_PASSWORD VALKEY_PASSWORD)

if [ ! -f "$FILE" ]; then
  [ -f .env.example ] || { echo "generate-secrets: $FILE and .env.example are missing" >&2; exit 1; }
  cp .env.example "$FILE"
fi

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

TMP="$(mktemp "$FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$FILE" "$TMP"
filled=()
for name in "${SECRETS[@]}"; do
  if grep -Eq "^${name}=[[:space:]]*$" "$TMP"; then
    value="$(random_hex)"
    # Hex has no characters that sed or the shell treat specially.
    sed "s|^${name}=.*|${name}=${value}|" "$TMP" >"$TMP.next" && mv "$TMP.next" "$TMP"
    filled+=("$name")
  elif ! grep -Eq "^${name}=" "$TMP"; then
    printf '%s=%s\n' "$name" "$(random_hex)" >>"$TMP"
    filled+=("$name")
  fi
done
# legacy codesh name (1.0.x); remove in 2.0
# An HTTPS alias needs a certificate for the new name. Only `tls internal` mints one by itself;
# an operator certificate usually names the old host. The v1.0.1 updater runs this in the staged
# candidate, so also look in the installation it exports through its lock path.
tls_internal() {
  local dir live="${GACHIPAD_LOCK_PATH:-${CODESH_LOCK_PATH:-}}" dirs=(tls)
  [ -z "$live" ] || dirs+=("$(dirname "$(dirname "$live")")/tls")
  for dir in "${dirs[@]}"; do
    grep -Eqs '^[[:space:]]*tls[[:space:]]+internal([[:space:]]|$)' "$dir"/*.caddy && return 0
  done
  return 1
}
# legacy codesh name (1.0.x); remove in 2.0
# v1.0.1 update.sh calls this NEW helper before inspecting/starting the NEW compose file.
# Pin the old installation's project and Mongo names; no live data is copied or renamed.
if grep -q '^CODESH_VERSION=' "$TMP" && ! grep -q '^GACHIPAD_LEGACY_INSTALL=1$' "$TMP"; then
  legacy_get() { sed -n "s/^$1=//p" "$TMP" | tail -n 1; }
  migrate_set() {
    sed "/^$1=/d" "$TMP" >"$TMP.next" && mv "$TMP.next" "$TMP"
    printf '%s=%s\n' "$1" "$2" >>"$TMP"
  }
  while IFS='=' read -r name value; do
    [[ "$name" == CODESH_* ]] || continue
    migrate_set "GACHIPAD_${name#CODESH_}" "$value"
  done <"$FILE"
  # The old offline updater only knows the old registry key; use the loaded bundle's names.
  if [ -f images.tar ]; then
    bundle_registry="$(sed -n 's/^GACHIPAD_REGISTRY=//p' .env.example | tail -n 1)"
    [ -z "$bundle_registry" ] || migrate_set GACHIPAD_REGISTRY "$bundle_registry"
  fi
  migrate_set GACHIPAD_PROJECT "${COMPOSE_PROJECT_NAME:-codesh}"
  migrate_set MONGO_ROOT_USER codesh
  migrate_set MONGO_APP_USER codesh_app
  migrate_set MONGO_DATABASE codesh
  if [ "$(legacy_get UPDATE_REPO)" = kim0040/codesh ]; then
    migrate_set UPDATE_REPO kim0040/gachipad
  fi
  # A custom operator hostname stays unchanged; the former default gains the new name too.
  # The updater appends the template's gachipad.local to a hand-trimmed .env before this runs.
  case "$(legacy_get MDNS_HOSTNAME)" in
    '' | codesh.local | gachipad.local)
      migrate_set MDNS_HOSTNAME gachipad.local
      migrate_set MDNS_ALIASES codesh.local
      case "$(legacy_get SITE_ADDRESS)" in
        codesh.local | https://codesh.local) if tls_internal; then migrate_set SITE_ALIASES ', gachipad.local'; fi ;;
        http://codesh.local) migrate_set SITE_ALIASES ', http://gachipad.local' ;;
      esac
      ;;
  esac
  # Stop the deprecation warning: the old lines were copied above. A comment line is ignored
  # by the v1.0.1 updater, which reads CODESH_* from the live .env only and restores its own
  # copy of it on rollback.
  sed 's/^\(CODESH_[A-Za-z0-9_]*=.*\)$/# migrated to GACHIPAD_*: \1/' "$TMP" >"$TMP.next" && mv "$TMP.next" "$TMP"
  migrate_set GACHIPAD_LEGACY_INSTALL 1
  echo "warning: migrated legacy installation settings; existing data locations retained" >&2
fi

# Replace atomically (same directory) so an interrupted run never leaves a truncated .env.
chmod 600 "$TMP" && mv "$TMP" "$FILE"
# The legacy upgrader calls this helper before starting Compose, but does not copy state/.
# Create the status mount as the operator so Docker cannot create a root-owned directory.
mkdir -p state && chmod 755 state
if [ "${#filled[@]}" -gt 0 ]; then
  echo "generate-secrets: wrote ${filled[*]} to $FILE"
else
  echo "generate-secrets: $FILE already has all secrets"
fi
