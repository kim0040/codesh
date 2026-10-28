#!/usr/bin/env bash
# Installs gachipad from an offline bundle: loads the images, creates .env with fresh secrets and
# starts the stack. Needs docker with the compose plugin; no internet.
#
#   tar xzf gachipad-<version>.tar.gz && cd gachipad-<version> && ./install.sh
#   PUBLIC_URL=http://gachipad.local HTTP_PORT=8080 ./install.sh     # optional settings for a new .env
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
assert_no_database_migration

DB_OPTION=""
DB_URL_OPTION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_OPTION="${2:?--db needs sqlite, postgres, mongodb or external}"; shift ;;
    --database-url) DB_URL_OPTION="${2:?--database-url needs a URL}"; shift ;;
    -h | --help)
      echo "usage: ./install.sh [--db sqlite|postgres|mongodb|external] [--database-url URL]"
      exit 0
      ;;
    *) die "unknown option $1 (./install.sh --help)" ;;
  esac
  shift
done

valid_db_option() {
  case "$1" in sqlite | postgres | mongodb | external) return 0 ;; *) return 1 ;; esac
}

host_database_options() {
  local output="" memory="unknown" image
  local -a detected=() clients=()
  local label port
  for label in 'PostgreSQL:5432' 'MySQL/MariaDB:3306' 'MongoDB:27017'; do
    port="${label##*:}"; label="${label%:*}"
    if { command -v timeout >/dev/null 2>&1 && timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; } ||
      { ! command -v timeout >/dev/null 2>&1 && bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; }; then
      detected+=("$label localhost:$port")
    fi
  done
  while IFS= read -r image; do
    case "$image" in
      postgres:* | postgres@* | */postgres:* | */postgres@*) detected+=("PostgreSQL container") ;;
      mysql:* | mariadb:* | mysql@* | mariadb@* | */mysql:* | */mariadb:* | */mysql@* | */mariadb@*) detected+=("MySQL/MariaDB container") ;;
      mongo:* | mongo@* | */mongo:* | */mongo@*) detected+=("MongoDB container") ;;
    esac
  done < <(docker ps --format '{{.Image}}' 2>/dev/null)
  if command -v psql >/dev/null 2>&1; then clients+=(psql); fi
  if command -v mysql >/dev/null 2>&1 || command -v mariadb >/dev/null 2>&1; then clients+=(mysql/mariadb); fi
  if command -v mongosh >/dev/null 2>&1 || command -v mongodump >/dev/null 2>&1; then clients+=(MongoDB); fi
  if [ -r /proc/meminfo ]; then
    memory="$(awk '$1 == "MemAvailable:" {printf "%.1f GiB", $2 / 1048576}' /proc/meminfo)"
  elif command -v vm_stat >/dev/null 2>&1; then
    memory="$(vm_stat | awk '
      NR == 1 {for (i = 1; i < NF; i++) if ($i == "of") size = $(i + 1)}
      /Pages (free|inactive|speculative):/ {gsub(/\./, "", $3); pages += $3}
      END {if (size) printf "%.1f GiB", pages * size / 1073741824}
    ')"
  fi
  [ -n "$memory" ] || memory=unknown
  for label in ${detected[@]+"${detected[@]}"}; do [ -z "$output" ] || output+=", "; output+="$label"; done
  [ -n "$output" ] || output=none
  local client_text="none"
  if [ "${#clients[@]}" -gt 0 ]; then
    client_text=""
    for label in "${clients[@]}"; do [ -z "$client_text" ] || client_text+=", "; client_text+="$label"; done
  fi
  echo "install: local database detection: $output; clients: $client_text; available memory: $memory (no credentials were tried)."
}

select_database() {
  local fresh="$1" file_url selected answer scheme
  local source=""
  file_url="$(env_get DATABASE_URL)"
  if [ -n "$DB_URL_OPTION" ]; then
    DATABASE_URL="$DB_URL_OPTION"; export DATABASE_URL
    source=--database-url
  elif [ -n "${DATABASE_URL:-}" ]; then source=DATABASE_URL
  elif [ -n "$file_url" ]; then DATABASE_URL="$file_url"; source=.env
  fi
  if [ -n "$source" ]; then
    validate_database_url "$DATABASE_URL" 2>/dev/null || die "DATABASE_URL has an unsupported scheme"
    scheme="${DATABASE_URL%%:*}"
    if [ "$scheme" = sqlite ]; then selected=sqlite; else selected=external; fi
    if [ "$selected" = external ]; then reason="DATABASE_URL was supplied; using its external database"
    else reason="DATABASE_URL was supplied; using its SQLite file"; fi
  elif [ -n "$DB_OPTION" ]; then
    valid_db_option "$DB_OPTION" || die "--db must be sqlite, postgres, mongodb or external"
    selected="$DB_OPTION"
    DATABASE_URL=""
    reason="selected with --db $selected"
  elif [ -n "${GACHIPAD_DB:-}" ]; then
    valid_db_option "$GACHIPAD_DB" || die "GACHIPAD_DB must be sqlite, postgres, mongodb or external"
    selected="$GACHIPAD_DB"
    reason="selected with GACHIPAD_DB"
  elif [ "$fresh" = 0 ] && [ -n "$(env_get GACHIPAD_DB)" ]; then
    selected="$(env_get GACHIPAD_DB)"
    valid_db_option "$selected" || die "GACHIPAD_DB must be sqlite, postgres, mongodb or external"
    reason="kept the existing .env database choice"
  elif [ "$fresh" = 0 ] && grep -Eq '^MONGO_[A-Z0-9_]+=' .env; then
    selected=mongodb
    reason="kept the existing MongoDB installation"
  elif [ "$fresh" = 1 ]; then
    selected=sqlite
    reason="recommended because it needs no server credentials and has the lowest setup and memory cost"
    host_database_options
    if [ -t 0 ]; then
      echo "sqlite — setup: simple; memory: low; scale-out: one host; backup: online SQLite snapshot"
      echo "postgres — setup: bundled service; memory: medium; scale-out: multiple app replicas; backup: pg_dump"
      echo "mongodb — setup: bundled service; memory: higher; scale-out: multiple app replicas; backup: mongodump"
      echo "external — setup: provide DATABASE_URL; memory: external server; scale-out: server-dependent; backup: operator-managed"
      read -r -p "Database [sqlite/postgres/mongodb/external] (default sqlite): " answer
      answer="${answer:-sqlite}"
      valid_db_option "$answer" || die "choose sqlite, postgres, mongodb or external"
      selected="$answer"
      reason="selected interactively"
    fi
  else
    selected=sqlite
    reason="defaulted to SQLite because no database setting or MongoDB settings were present"
  fi
  if [ "$selected" = external ] && [ -z "${DATABASE_URL:-$(env_get DATABASE_URL)}" ]; then
    [ -t 0 ] || die "GACHIPAD_DB=external requires DATABASE_URL"
    read -r -s -p "DATABASE_URL (hidden): " DATABASE_URL
    printf '\n'
    export DATABASE_URL
    validate_database_url "$DATABASE_URL" 2>/dev/null || die "DATABASE_URL has an unsupported scheme"
  fi
  GACHIPAD_DB="$selected"
  export GACHIPAD_DB DATABASE_URL
  echo "install: database $selected; $reason."
}

need_docker
verify_bundle .

[ -f images.tar ] || die "images.tar is missing: run this from the extracted bundle"
VERSION="$(cat VERSION)"
ENV_SNAPSHOT=""
ENV_SNAPSHOT_READY=0
ENV_READY=0
install_cleanup() {
  local status=$? restored=1
  trap - EXIT
  trap '' HUP INT TERM PIPE
  if [ "$ENV_READY" = 0 ] && [ "$ENV_SNAPSHOT_READY" = 1 ]; then
    if [ "$FRESH" = 0 ]; then
      cp -p "$ENV_SNAPSHOT" .env.install-recovery && mv .env.install-recovery .env || restored=0
    else rm -f .env || restored=0; fi
  fi
  if [ "$restored" = 1 ]; then
    [ -z "$ENV_SNAPSHOT" ] || rm -f "$ENV_SNAPSHOT"
    rm -f .env.install-recovery
  else
    echo "install: could not restore .env; original snapshot kept at $ENV_SNAPSHOT" >&2
    status=1
  fi
  install_unlock
  exit "$status"
}
trap install_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
install_lock
assert_no_database_migration

# legacy codesh name (1.0.x); remove in 2.0
# A 1.0.x installation keeps its data in codesh_* volumes. A folder without its .env would start an
# empty gachipad project next to them, so stop unless the operator named a project or opted in.
if [ ! -f .env ] && [ -z "${COMPOSE_PROJECT_NAME:-}${GACHIPAD_PROJECT:-}${GACHIPAD_NEW_INSTALL:-}" ] &&
  grep -qx codesh_mongo-data < <(docker volume ls -q); then
  die "the volumes of a codesh 1.0.x installation (codesh_mongo-data) exist on this host, but this folder has no .env. Update that installation in its own folder (./update.sh, or ./upgrade.sh <bundle>), or copy its .env here and run ./generate-secrets.sh .env first to keep its data. For a separate new installation set GACHIPAD_NEW_INSTALL=1."
fi

FRESH=0
if [ -f .env ]; then
  echo "install: keeping the existing .env"
else
  FRESH=1
fi
select_database "$FRESH"
echo "install: loading images ($VERSION)"
docker load -i images.tar
assert_database_backend

# Persist settings only after the backend guard has accepted the proposed selection.
ENV_SNAPSHOT="$(mktemp .env.install-snapshot.XXXXXX)"
[ "$FRESH" = 1 ] || cp -p .env "$ENV_SNAPSHOT"
ENV_SNAPSHOT_READY=1
[ "$FRESH" = 0 ] || cp .env.example .env
for name in PUBLIC_URL HTTP_PORT HTTPS_PORT SITE_ADDRESS COLLAB_REPLICAS; do
  value="${!name:-}"
  [ -n "$value" ] && env_set "$name" "$value"
done
env_set DATABASE_URL "${DATABASE_URL:-}"
env_set GACHIPAD_DB "$GACHIPAD_DB"
./generate-secrets.sh .env
env_set GACHIPAD_VERSION "$VERSION"
# The loaded images carry the bundle's registry in their names.
REGISTRY="$(sed -n 's/^GACHIPAD_REGISTRY=//p' .env.example | tail -n 1)"
[ -n "$REGISTRY" ] && env_set GACHIPAD_REGISTRY "$REGISTRY"
mkdir -p state && chmod 755 state

echo "install: starting"
ENV_READY=1
docker compose up -d --wait
wait_healthy 120
record_database_backend
echo "install: gachipad $VERSION is running on port $(env_get HTTP_PORT 80)"
echo "install: back up with ./backup.sh, update with ./update.sh (online) or ./upgrade.sh <new bundle>"
