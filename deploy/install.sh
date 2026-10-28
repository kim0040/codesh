#!/usr/bin/env bash
# Installs gachipad from an offline bundle or pulls released images online, creates .env with
# fresh secrets and starts the stack. --check only reports prerequisites; --yes never prompts.
#
#   tar xzf gachipad-<version>.tar.gz && cd gachipad-<version> && ./install.sh
#   PUBLIC_URL=http://gachipad.local HTTP_PORT=8080 ./install.sh     # optional settings for a new .env
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh
declare -F assert_no_database_migration >/dev/null || die 'lib.sh is older than this script'
assert_no_database_migration

DB_OPTION=""
DB_URL_OPTION=""
MDNS_OPTION="${GACHIPAD_MDNS:-auto}"
NETWORK_OPTION=""
GACHIPAD_NETWORK_ENV="${GACHIPAD_NETWORK:-}"
DOMAIN_OPTION=""
PROXY_OPTION=""
PROXY_OPTION_SET=0
ACME_OPTION="${ACME_EMAIL:-}"
CHECK_ONLY=0
ASSUME_YES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --db) DB_OPTION="${2:?--db needs sqlite, postgres, mongodb or external}"; shift ;;
    --database-url) DB_URL_OPTION="${2:?--database-url needs a URL}"; shift ;;
    --mdns) MDNS_OPTION=1 ;;
    --no-mdns) MDNS_OPTION=0 ;;
    --network) NETWORK_OPTION="${2:?--network needs internal or public}"; shift ;;
    --domain) DOMAIN_OPTION="${2:?--domain needs a DNS name}"; shift ;;
    --behind-proxy) PROXY_OPTION="${2:?--behind-proxy needs a CIDR}"; PROXY_OPTION_SET=1; shift ;;
    --acme-email) ACME_OPTION="${2:?--acme-email needs an email address}"; shift ;;
    -h | --help)
      echo "usage: ./install.sh [--check] [--yes] [--db sqlite|postgres|mongodb|external] [--database-url URL] [--mdns|--no-mdns] [--network internal|public] [--domain DNS-NAME] [--behind-proxy CIDR] [--acme-email EMAIL]"
      exit 0
      ;;
    *) die "unknown option $1 (./install.sh --help)" ;;
  esac
  shift
done

# Existing selection helpers use TTY detection; detach input for unattended/check-only runs.
if [ "$ASSUME_YES" = 1 ] || [ "$CHECK_ONLY" = 1 ]; then exec </dev/null; fi

case "$MDNS_OPTION" in auto | 0 | 1) ;; *) die "GACHIPAD_MDNS must be 0 or 1" ;; esac

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

# Verify offline bytes before invoking host probes. Online trees have no image archive to verify.
OFFLINE=0
if [ -f images.tar ]; then
  OFFLINE=1
  verify_bundle .
  echo 'install: offline bundle checksum passed.'
  VERSION="$(cat VERSION)"
else
  echo 'install: online mode; bundle checksum check skipped because images.tar is absent.'
  VERSION="$(sed -n 's/^GACHIPAD_VERSION=//p' .env.example | tail -n 1)"
  [ -n "$VERSION" ] || die 'GACHIPAD_VERSION is missing from .env.example; restore the release template'
fi

FRESH=1
[ ! -f .env ] || FRESH=0
select_database "$FRESH"
select_network "$FRESH"
[ -r ./preflight.sh ] || die 'preflight.sh is missing: extract all files from the matching release before installing'
# shellcheck source=preflight.sh
. ./preflight.sh
preflight_run || exit 1
[ "$CHECK_ONLY" = 0 ] || exit 0
ENV_SNAPSHOT=""
ENV_SNAPSHOT_READY=0
ENV_READY=0
START_ATTEMPTED=0
install_cleanup() {
  local status=$? restored=1
  trap - EXIT
  trap '' HUP INT TERM PIPE
  if [ "$ENV_READY" = 0 ] && [ "$ENV_SNAPSHOT_READY" = 1 ]; then
    if [ "$START_ATTEMPTED" = 1 ]; then
      docker compose stop caddy >/dev/null 2>&1 || true
      docker compose --profile mdns stop mdns >/dev/null 2>&1 || true
      if [ "$FRESH" = 1 ]; then docker compose stop >/dev/null 2>&1 || true; fi
    fi
    if [ "$FRESH" = 0 ]; then
      cp -p "$ENV_SNAPSHOT" .env.install-recovery && mv .env.install-recovery .env || restored=0
    else rm -f .env || restored=0; fi
    if [ "$restored" = 1 ] && [ "$FRESH" = 0 ] && [ "$START_ATTEMPTED" = 1 ]; then
      # Candidate process overrides must not mask the restored file during rollback.
      unset GACHIPAD_NETWORK PUBLIC_URL SITE_ADDRESS COMPOSE_PROFILES GACHIPAD_DB DATABASE_URL HTTP_PORT HTTPS_PORT COLLAB_REPLICAS NETWORK_SUBNET NETWORK_GATEWAY TRUST_PROXY
      local -a restart_command=(docker compose up -d --wait --wait-timeout 120)
      # macOS does not ship GNU timeout; Compose still bounds the readiness wait there.
      if command -v timeout >/dev/null 2>&1; then restart_command=(timeout -k 5 150 "${restart_command[@]}"); fi
      "${restart_command[@]}" || { echo 'install: settings restored; could not restart the previous configuration. Run docker compose up -d --wait.' >&2; status=1; }
    fi
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
if [ "$OFFLINE" = 1 ]; then
  echo "install: loading images ($VERSION)"
  docker load -i images.tar
else
  echo "install: pulling released images ($VERSION)"
  # Compose interpolation requires secrets even for pull. Use non-secret placeholders in this
  # subshell, without creating .env or printing existing credentials. The release template pins
  # the registry/version; profiles match selection, including the optional internal mDNS probe.
  if ! (
    export SESSION_SECRET=pull COLLAB_SECRET=pull MONGO_PASSWORD=pull MONGO_APP_PASSWORD=pull VALKEY_PASSWORD=pull POSTGRES_PASSWORD=pull
    export GACHIPAD_VERSION="$VERSION" GACHIPAD_REGISTRY
    GACHIPAD_REGISTRY="$(sed -n 's/^GACHIPAD_REGISTRY=//p' .env.example | tail -n 1)"
    export GACHIPAD_DATABASE_URL=sqlite:///data/gachipad.db COMPOSE_PROFILES=""
    local_profiles=(docker compose --env-file .env.example)
    case "$GACHIPAD_DB" in postgres|mongodb) local_profiles+=(--profile "$GACHIPAD_DB") ;; esac
    if [ "$GACHIPAD_NETWORK" = internal ] && [ "$MDNS_OPTION" != 0 ]; then local_profiles+=(--profile mdns); fi
    "${local_profiles[@]}" pull --quiet
  ) >/dev/null 2>&1; then
    die 'no internet: use the offline bundle (registry unavailable, authentication denied or release images missing); .env was not changed'
  fi
fi
assert_database_backend

# Persist settings only after the backend guard has accepted the proposed selection.
ENV_SNAPSHOT="$(mktemp .env.install-snapshot.XXXXXX)"
[ "$FRESH" = 1 ] || cp -p .env "$ENV_SNAPSHOT"
ENV_SNAPSHOT_READY=1
[ "$FRESH" = 0 ] || cp .env.example .env
persist_network "$FRESH"
for name in PUBLIC_URL HTTP_PORT HTTPS_PORT SITE_ADDRESS COLLAB_REPLICAS MONGO_CACHE_GB; do
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
if [ "$GACHIPAD_NETWORK" = public ]; then
  mdns_profile 0
  echo 'mdns: disabled in public mode.'
elif [ "$FRESH" = 0 ] && [ "$MDNS_OPTION" = auto ] && mdns_supported; then
  echo 'mdns: keeping the existing choice and hostname.'
else select_mdns "$MDNS_OPTION"; fi
mkdir -p state && chmod 755 state

echo "install: starting"
START_ATTEMPTED=1
if [ "$FRESH" = 0 ] && ! mdns_enabled; then
  if ! docker compose --profile mdns stop mdns; then
    [ "$GACHIPAD_NETWORK" != public ] || die 'could not disable the existing mDNS service; public mode was not started'
    echo 'mdns: could not stop the existing service; inspect docker compose --profile mdns ps mdns.' >&2
  fi
fi
docker compose up -d --wait
wait_healthy 120
record_database_backend
ENV_READY=1
echo "install: gachipad $VERSION is running on port $(env_get HTTP_PORT 80)"
network_addresses
echo "install: back up with ./backup.sh, update with ./update.sh (online) or ./upgrade.sh <new bundle>"
