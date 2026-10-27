#!/usr/bin/env bash
# Offline database copy; source data and its volume are retained after the switch.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh

TO=""
TARGET_URL="${DATABASE_URL:-}"
YES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --to) TO="${2:?--to needs sqlite, postgres, mongodb or external}"; shift ;;
    --database-url) TARGET_URL="${2:?--database-url needs a URL}"; shift ;;
    --yes) YES=1 ;;
    -h | --help)
      echo 'usage: ./migrate-db.sh --to sqlite|postgres|mongodb|external [--database-url URL] [--yes]'
      exit 0 ;;
    *) die 'unknown option (./migrate-db.sh --help)' ;;
  esac
  shift
done
case "$TO" in sqlite | postgres | mongodb | external) ;; *) die '--to must be sqlite, postgres, mongodb or external' ;; esac
if [ "$TO" = external ]; then
  [ -n "$TARGET_URL" ] || die '--to external requires --database-url or DATABASE_URL'
  validate_database_url "$TARGET_URL" || die 'DATABASE_URL has an unsupported scheme'
  [[ "$TARGET_URL" != sqlite:* ]] || die '--to external requires a server database URL'
else
  [ -z "$TARGET_URL" ] || die '--database-url and DATABASE_URL are only accepted with --to external'
fi
# The source is always the saved installation, never an exported target selection.
unset DATABASE_URL GACHIPAD_DB COMPOSE_PROFILES GACHIPAD_DATABASE_URL
need_docker
[ -f .env ] || die '.env is missing; run this from the installed bundle'
install_lock
STAGE=""
CONFIG_SNAPSHOT_READY=0
STOPPED=0
COPY_STARTED=0
SUCCESS=0
NEW_VOLUME=0
TARGET_VOLUME=""

migration_cleanup() {
  local status=$? recovered=1 service
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$SUCCESS" = 0 ] && [ -n "$STAGE" ]; then
    if [ "$STOPPED" = 1 ]; then
      stop_writes restore >&2 || recovered=0
    fi
    if [ "$CONFIG_SNAPSHOT_READY" = 1 ]; then
      cp -p "$STAGE/original.env" .env.migrate-recovery && mv .env.migrate-recovery .env || recovered=0
      if [ -f "$STAGE/original.kind" ]; then
        cp -p "$STAGE/original.kind" state/database-kind.tmp && mv state/database-kind.tmp state/database-kind || recovered=0
      else rm -f state/database-kind; fi
    fi
    if [ "$STOPPED" = 1 ] && [ "$recovered" = 1 ]; then
      database_start 120 && docker compose up -d --wait --wait-timeout 120 api collab &&
        wait_api 120 && docker compose up -d && wait_healthy 120 || recovered=0
    fi
    case "$TO" in
      postgres) service=postgres ;;
      mongodb) service=mongo ;;
      *) service="" ;;
    esac
    if [ -n "$service" ] && [ "$TO" != "$SOURCE" ] && [ "$STOPPED" = 1 ]; then
      docker compose --env-file "$STAGE/.env" stop "$service" >&2 || recovered=0
      if [ "$NEW_VOLUME" = 1 ]; then
        if [ "$TO" = mongodb ]; then
          docker compose --env-file "$STAGE/.env" rm -sf mongo-users mongo >&2 || recovered=0
        else docker compose --env-file "$STAGE/.env" rm -sf "$service" >&2 || recovered=0; fi
      fi
    fi
    if [ "$NEW_VOLUME" = 1 ]; then
      if docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1; then
        docker volume rm "$TARGET_VOLUME" >/dev/null || {
          echo 'migrate-db: could not remove the newly created destination volume; inspect it before retrying.' >&2
          recovered=0
        }
      fi
    fi
    if [ "$COPY_STARTED" = 1 ]; then
      echo 'migrate-db: destination may hold a partial copy; inspect and clear it before retrying. Existing destination volumes are kept.' >&2
    fi
    if [ "$recovered" = 1 ]; then
      echo 'migrate-db: migration failed; previous configuration restored and old backend retained.' >&2
    else
      echo "migrate-db: automatic recovery incomplete; configuration snapshots kept in $STAGE; keep writers stopped and recover the old backend before retrying." >&2
    fi
  fi
  if [ -n "$STAGE" ] && [ "$recovered" = 1 ]; then
    rm -rf "$STAGE"
    rm -f .env.migrate-next .env.migrate-recovery state/database-kind.tmp state/transaction
  fi
  install_unlock
  exit "$status"
}
trap migration_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SOURCE="$(database_kind)"
SOURCE_URL="$(env_get DATABASE_URL "$(env_get GACHIPAD_DATABASE_URL)")"
[ -n "$SOURCE_URL" ] || die 'source database URL is missing; run ./generate-secrets.sh first'

[ ! -e state/transaction ] || die 'unfinished transaction exists; recover it before migrating'
marker="$(cat state/database-kind 2>/dev/null || true)"
[ -z "$marker" ] || [ "$marker" = "$SOURCE" ] || die 'saved backend disagrees with state/database-kind; recover the configuration first'
if [ "$SOURCE" = external ] && [ "$TO" = external ]; then
  [ "$SOURCE_URL" != "$TARGET_URL" ] || die 'migration refused: source and destination external URLs are identical'
elif [ "$SOURCE" = "$TO" ]; then die 'migration refused: this bundled backend is already selected'; fi
if [ "$SOURCE" = external ]; then
  [ "${GACHIPAD_EXTERNAL_BACKUP_CONFIRMED:-$(env_get GACHIPAD_EXTERNAL_BACKUP_CONFIRMED)}" = 1 ] ||
    die 'external source requires GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1 after an external server backup'
fi
if [ "$YES" = 0 ]; then
  [ -t 0 ] || die 'migration needs confirmation; pass --yes for non-interactive use'
  read -r -p "Copy $SOURCE to $TO with API, collab and ingress stopped? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die 'cancelled'
fi

# Generate the target profile and secrets in a private staging directory. Live .env stays intact.
STAGE="$(mktemp -d .env.migrate-db.XXXXXX)"
cp -p .env "$STAGE/original.env"
[ ! -f state/database-kind ] || cp -p state/database-kind "$STAGE/original.kind"
CONFIG_SNAPSHOT_READY=1
printf 'database migration\n' >state/transaction
cp generate-secrets.sh .env.example "$STAGE/"
cp -p .env "$STAGE/.env"
(
  cd "$STAGE"
  env_set GACHIPAD_DB "$TO"
  env_set DATABASE_URL "$TARGET_URL"
  # Historical MongoDB namespace settings stay explicit; pinning has served its upgrade purpose.
  env_set GACHIPAD_LEGACY_INSTALL 0
  unset GACHIPAD_LOCK_PATH CODESH_LOCK_PATH
  ./generate-secrets.sh >/dev/null
)
TARGET_CONNECTION="$(cd "$STAGE" && env_get DATABASE_URL "$(env_get GACHIPAD_DATABASE_URL)")"
if [ "$TO" != external ]; then
  TARGET_VOLUME="$(database_project)_$(database_volume_suffix "$TO")"
  docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1 || NEW_VOLUME=1
fi

echo "migrate-db: backing up $SOURCE before copying to $TO."
database_backup ./backups || die 'source backup failed; migration cancelled'
STOPPED=1
stop_writes || die 'writers did not stop cleanly; migration cancelled'
case "$TO" in
  postgres) docker compose --env-file "$STAGE/.env" up -d --wait --wait-timeout 120 postgres ;;
  mongodb)
    docker compose --env-file "$STAGE/.env" up -d --wait --wait-timeout 120 mongo
    docker compose --env-file "$STAGE/.env" run --rm --no-deps --pull never -T mongo-users ;;
esac

echo 'migrate-db: copying offline; records expiring within 15 minutes are skipped.'
COPY_STARTED=1
copy_status=0
GACHIPAD_COPY_FROM="$SOURCE_URL" GACHIPAD_COPY_TO="$TARGET_CONNECTION" \
  docker compose --env-file "$STAGE/.env" run --rm --no-deps --pull never -T \
    -e GACHIPAD_COPY_FROM -e GACHIPAD_COPY_TO api npm run --silent copy-db || copy_status=$?
if [ "$copy_status" != 0 ]; then
  echo "migrate-db: copy exited $copy_status; configuration will be restored." >&2
  exit "$copy_status"
fi

# Publish the target env atomically and marker under the same install lock; EXIT restores both.
cp -p "$STAGE/.env" .env.migrate-next
mv .env.migrate-next .env
record_database_backend
database_start 120
docker compose up -d --wait --wait-timeout 120 api collab
wait_api 120
docker compose up -d
wait_healthy 120
SUCCESS=1
echo "migrate-db: success ($SOURCE -> $TO); previous backend data and backups are kept."
if [ "$SOURCE" = external ]; then
  echo 'migrate-db: after checking shares and uploads, remove the old external database manually with its server tools.'
else
  OLD_VOLUME="$(database_project)_$(database_volume_suffix "$SOURCE")"
  case "$SOURCE" in
    mongodb) echo 'migrate-db: after checking shares and uploads, run: docker compose --profile mongodb rm -sf mongo-users mongo' ;;
    postgres) echo 'migrate-db: after checking shares and uploads, run: docker compose --profile postgres rm -sf postgres' ;;
    sqlite) echo 'migrate-db: after checking shares and uploads, stop ingress and release the data mount first: docker compose stop caddy api collab && docker compose rm -f api collab' ;;
  esac
  echo "migrate-db: then remove the old data manually: docker volume rm $OLD_VOLUME"
  [ "$SOURCE" != sqlite ] || echo 'migrate-db: then restart the application: docker compose up -d'
fi
