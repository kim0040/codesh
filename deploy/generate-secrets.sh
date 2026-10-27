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
# Check the operator's settings before filling the compatibility Mongo secrets.
had_mongo=0
if grep -Eq '^MONGO_[A-Z0-9_]+=' "$TMP"; then had_mongo=1; fi
set_tmp() {
  local name="$1" value="$2" next="$TMP.next" line found=0
  case "$name" in DATABASE_URL | GACHIPAD_DATABASE_URL)
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
      echo "generate-secrets: $name must be a single line" >&2; exit 1;
    }
    [ -z "$value" ] || value="'${value//\'/\\\'}'"
    ;;
  esac
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" == "$name="* ]]; then
      if [ "$found" = 0 ]; then printf '%s=%s\n' "$name" "$value" >>"$next"; found=1; fi
    else printf '%s\n' "$line" >>"$next"; fi
  done <"$TMP"
  [ "$found" = 1 ] || printf '%s=%s\n' "$name" "$value" >>"$next"
  mv "$next" "$TMP"
}
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
  migrate_set() { set_tmp "$1" "$2"; }
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
  migrate_set GACHIPAD_DB mongodb
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

tmp_get() {
  local value
  value="$(sed -n "s/^$1=//p" "$TMP" | tail -n 1)"
  if [[ "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\'/\'}"
  elif [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}
# Pre-selection renamed updaters append every new template key, including the SQLite
# default, before calling this staged helper. Read their unchanged live env to pin MongoDB.
pin_mongo=0
live_lock="${GACHIPAD_LOCK_PATH:-${CODESH_LOCK_PATH:-}}"
if [ -n "$live_lock" ]; then
  live_env="$(dirname "$(dirname "$live_lock")")/.env"
  if [ -f "$live_env" ] && ! grep -q '^GACHIPAD_DB=' "$live_env" &&
    grep -Eq '^MONGO_[A-Z0-9_]+=' "$live_env"; then pin_mongo=1; fi
fi
if [ "$(tmp_get GACHIPAD_LEGACY_INSTALL)" = 1 ]; then pin_mongo=1; fi
database_url="${DATABASE_URL:-$(tmp_get DATABASE_URL)}"
if [ "$pin_mongo" = 1 ] && { [ -n "$database_url" ] || { [ -n "${GACHIPAD_DB:-}" ] && [ "$GACHIPAD_DB" != mongodb ]; }; }; then
  echo "generate-secrets: database backend change refused (mongodb -> requested backend); data copy is not available yet. Keep the existing backend until the future copy tool is available." >&2
  exit 1
fi
if [ -n "$database_url" ]; then
  [[ "$database_url" != *$'\n'* && "$database_url" != *$'\r'* ]] || {
    echo "generate-secrets: DATABASE_URL must be a single line" >&2; exit 1;
  }
  scheme="${database_url%%:*}"
  case "$scheme" in sqlite | postgres | postgresql | mysql | mariadb | mongodb | mongodb+srv) ;;
    *) echo "generate-secrets: DATABASE_URL has an unsupported scheme" >&2; exit 1 ;;
  esac
  [ -z "${DATABASE_URL:-}" ] || set_tmp DATABASE_URL "$DATABASE_URL"
  if [ "$scheme" = sqlite ]; then db=sqlite; else db=external; fi
else
  if [ "$pin_mongo" = 1 ]; then
    if [ -n "$(tmp_get GACHIPAD_DB)" ] && [ "$(tmp_get GACHIPAD_DB)" != mongodb ]; then
      echo "generate-secrets: database backend change refused (mongodb -> requested backend); data copy is not available yet. Keep the existing backend until the future copy tool is available." >&2
    fi
    db=mongodb
  else db="${GACHIPAD_DB:-$(tmp_get GACHIPAD_DB)}"; fi
  if [ -z "$db" ]; then
    if [ "$had_mongo" = 1 ]; then db=mongodb; else db=sqlite; fi
  fi
fi
marker="$(cat state/database-kind 2>/dev/null || true)"
if [ -n "$marker" ] && [ "$marker" != "$db" ]; then
  echo "generate-secrets: database backend change refused ($marker -> $db); data copy is not available yet. Keep the existing backend until the future copy tool is available." >&2
  exit 1
fi
case "$db" in
  sqlite)
    compose_database_url="${database_url:-sqlite:///data/gachipad.db}"
    ;;
  postgres)
    if grep -Eq '^POSTGRES_PASSWORD=[[:space:]]*$' "$TMP" || ! grep -Eq '^POSTGRES_PASSWORD=' "$TMP"; then
      set_tmp POSTGRES_PASSWORD "$(random_hex)"
      filled+=(POSTGRES_PASSWORD)
    fi
    pg_user="${POSTGRES_USER:-$(tmp_get POSTGRES_USER)}"; pg_user="${pg_user:-gachipad_app}"
    pg_db="${POSTGRES_DATABASE:-$(tmp_get POSTGRES_DATABASE)}"; pg_db="${pg_db:-gachipad}"
    pg_password="$(tmp_get POSTGRES_PASSWORD)"
    compose_database_url="postgresql://$pg_user:$pg_password@postgres:5432/$pg_db"
    ;;
  mongodb)
    mongo_user="$(tmp_get MONGO_APP_USER)"; mongo_user="${mongo_user:-gachipad_app}"
    mongo_db="$(tmp_get MONGO_DATABASE)"; mongo_db="${mongo_db:-gachipad}"
    mongo_password="$(tmp_get MONGO_APP_PASSWORD)"
    compose_database_url="mongodb://$mongo_user:$mongo_password@mongo:27017/$mongo_db?authSource=$mongo_db"
    ;;
  external)
    [ -n "$database_url" ] || { echo "generate-secrets: DATABASE_URL is required when GACHIPAD_DB=external" >&2; exit 1; }
    compose_database_url=
    ;;
  *) echo "generate-secrets: GACHIPAD_DB must be sqlite, postgres, mongodb or external" >&2; exit 1 ;;
esac

set_tmp GACHIPAD_DB "$db"
set_tmp GACHIPAD_DATABASE_URL "$compose_database_url"

profiles="${COMPOSE_PROFILES:-$(tmp_get COMPOSE_PROFILES)}"
profile_list=()
IFS=',' read -r -a existing_profiles <<<"$profiles"
for profile in ${existing_profiles[@]+"${existing_profiles[@]}"}; do
  profile="${profile#"${profile%%[![:space:]]*}"}"
  profile="${profile%"${profile##*[![:space:]]}"}"
  [ -n "$profile" ] || continue
  case "$profile" in mongodb | postgres) continue ;; esac
  found=0
  for existing in ${profile_list[@]+"${profile_list[@]}"}; do [ "$existing" = "$profile" ] && found=1; done
  [ "$found" = 1 ] || profile_list+=("$profile")
done
case "$db" in mongodb | postgres)
  found=0
  for existing in ${profile_list[@]+"${profile_list[@]}"}; do [ "$existing" = "$db" ] && found=1; done
  [ "$found" = 1 ] || profile_list+=("$db")
  ;;
esac
profiles=""
for profile in ${profile_list[@]+"${profile_list[@]}"}; do
  [ -z "$profiles" ] || profiles+=,
  profiles+="$profile"
done
set_tmp COMPOSE_PROFILES "$profiles"

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
