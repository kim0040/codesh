#!/usr/bin/env bash
# Bounded transaction fixtures; real cross-backend copies run in verify-databases.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$(mktemp -d)"
trap 'rm -rf "$F"' EXIT
mkdir "$F/bin"
cat >"$F/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = volume ]; then
  case "$2" in
    inspect) [ -f "$FIXTURE/volumes/$3" ] ;;
    rm) rm "$FIXTURE/volumes/$3"; echo volume-removed >>"$FIXTURE/events" ;;
  esac
  exit $?
fi
[ "$1" = compose ] || exit 0
shift
file=.env
if [ "${1:-}" = --env-file ]; then file="$2"; shift 2; fi
kind="$(sed -n 's/^GACHIPAD_DB=//p' "$file")"
printf '%s:%s\n' "$kind" "$1" >>"$FIXTURE/events"
if [[ "$*" == *'npm run --silent copy-db'* ]]; then
  [[ "$*" != *'://'* ]] || exit 97
  [ -n "${GACHIPAD_COPY_FROM:-}" ] && [ -n "${GACHIPAD_COPY_TO:-}" ] || exit 96
  cmp .env "$FIXTURE/before.env" || exit 95
  cmp state/database-kind "$FIXTURE/before.kind" || exit 94
  [ -f "$FIXTURE/stopped" ] || exit 93
  [ -f "$FIXTURE/backup" ] || exit 92
  case "$kind" in
    sqlite) touch "$FIXTURE/volumes/gp-dbdeploy-fixture_gachipad-data" ;;
    postgres) touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ;;
    mongodb) touch "$FIXTURE/volumes/gp-dbdeploy-fixture_mongo-data" ;;
  esac
  echo 'shares: 1'
  if [ "${COPY_STATUS:-0}" = 0 ]; then echo 'Result: success.'; else echo 'Result: refused or failed.'; fi
  exit "${COPY_STATUS:-0}"
fi
if [ "$1" = up ]; then
  case " $* " in
    *' postgres '*) touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ;;
    *' mongo '*) touch "$FIXTURE/volumes/gp-dbdeploy-fixture_mongo-data" ;;
  esac
  if [ "${FAIL_HEALTH:-0}" = 1 ] && [ "$kind" != "$(cat "$FIXTURE/before.kind")" ] && [[ "$*" == *'api collab'* ]]; then exit 1; fi
  printf '%s\n' "$kind" >"$FIXTURE/running"
fi
DOCKER
chmod +x "$F/bin/docker"
export PATH="$F/bin:$PATH" COMPOSE_PROJECT_NAME=gp-dbdeploy-fixture
make_fixture() {
  FIXTURE="$F/$1"
  export FIXTURE
  mkdir -p "$FIXTURE/install/state" "$FIXTURE/volumes"
  cp "$ROOT"/deploy/{migrate-db.sh,lib.sh,generate-secrets.sh,.env.example} "$FIXTURE/install/"
  cp "$ROOT/deploy/.env.example" "$FIXTURE/install/.env"
  (
    cd "$FIXTURE/install"
    . ./lib.sh
    env_set GACHIPAD_DB "$2"
    env_set COMPOSE_PROFILES mdns
    if [ "$2" = external ]; then env_set DATABASE_URL 'postgresql://fixture:private@source.invalid/db'; fi
    ./generate-secrets.sh >/dev/null
    record_database_backend
  )
  cp -p "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cp -p "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  printf '%s\n' "$2" >"$FIXTURE/running"
  # Keep transaction tests independent of database binaries and network health.
  cat >>"$FIXTURE/install/lib.sh" <<'LIB'
# shellcheck disable=SC2317 # sourced by migration entrypoint
need_docker() { :; }
# shellcheck disable=SC2317
database_backup() { touch "$FIXTURE/backup"; echo backup >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
stop_writes() { touch "$FIXTURE/stopped"; echo stopped >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
database_start() { echo start >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
wait_api() { :; }
# shellcheck disable=SC2317
wait_healthy() { :; }
LIB
}
run() { (cd "$FIXTURE/install" && ./migrate-db.sh "$@") >"$FIXTURE/run.log" 2>&1; }
clean_state() {
  [ ! -e "$FIXTURE/install/state/transaction" ]
  [ ! -e "$FIXTURE/install/state/install.lock.d" ]
  [ -z "$(find "$FIXTURE/install" -maxdepth 1 -name '.env.migrate-db.*')" ]
  ! grep -q 'private@\|postgresql://\|mongodb://' "$FIXTURE/run.log"
}
for pair in mongodb:sqlite sqlite:postgres postgres:external; do
  from="${pair%:*}"; to="${pair#*:}"
  make_fixture "success-$from" "$from"
  args=(--to "$to" --yes)
  if [ "$to" = external ]; then args+=(--database-url 'postgresql://fixture:private@target.invalid/db'); fi
  run "${args[@]}"
  [ "$(cat "$FIXTURE/install/state/database-kind")" = "$to" ]
  [ "$(cat "$FIXTURE/running")" = "$to" ]
  grep -q '^COMPOSE_PROFILES=mdns' "$FIXTURE/install/.env"
  grep -q 'previous backend data and backups are kept' "$FIXTURE/run.log"
  if grep -q 'volume-removed' "$FIXTURE/events"; then exit 1; fi
  clean_state
  echo "ok: $from -> $to publishes only after copy; keeps source and mdns"
done
for status in 1 2; do
  make_fixture "copy-$status" sqlite
  if COPY_STATUS="$status" run --to postgres --yes; then exit 1; else actual=$?; fi
  [ "$actual" = "$status" ]
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  [ "$(cat "$FIXTURE/running")" = sqlite ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
  grep -q 'destination may hold a partial copy' "$FIXTURE/run.log"
  clean_state
  echo "ok: copy exit $status survives npm invocation; old backend runs; new volume removed"
done
make_fixture existing-destination sqlite
touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
if COPY_STATUS=2 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
clean_state
echo 'ok: refused existing destination volume is retained'
make_fixture failed-health mongodb
if FAIL_HEALTH=1 run --to postgres --yes; then exit 1; fi
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
[ "$(cat "$FIXTURE/running")" = mongodb ]
clean_state
echo 'ok: failed target startup restores source configuration and marker'
make_fixture external-identical external
if run --to external --database-url 'postgresql://fixture:private@source.invalid/db' --yes; then exit 1; fi
grep -q 'URLs are identical' "$FIXTURE/run.log"
[ ! -e "$FIXTURE/backup" ]
clean_state
if run --to sqlite --yes; then exit 1; fi
grep -q 'GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1' "$FIXTURE/run.log"
[ ! -e "$FIXTURE/backup" ]
GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1 run --to sqlite --yes
clean_state
echo 'ok: identical external target and unacknowledged external source refuse before downtime'
make_fixture lock-held sqlite
(
  cd "$FIXTURE/install"
  . ./lib.sh
  install_lock
  trap install_unlock EXIT
  if env -u GACHIPAD_LOCK_PATH -u GACHIPAD_LOCK_PID -u GACHIPAD_LOCK_KIND ./migrate-db.sh --to postgres --yes >"$FIXTURE/run.log" 2>&1; then exit 1; fi
  grep -q 'another update'  "$FIXTURE/run.log"
)
clean_state
echo 'ok: migration respects the installation lock'
echo 'migrate-db.test.sh: all checks passed'
