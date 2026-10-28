#!/usr/bin/env bash
# Bounded transaction fixtures; real cross-backend copies run in verify-databases.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$(mktemp -d)"
trap 'rm -rf "$F"' EXIT
trap 'printf "migration fixture failed: %s at line %s\n" "${FIXTURE##*/}" "$LINENO" >&2' ERR
mkdir "$F/bin"
cat >"$F/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" != *'private@'* && "$*" != *'.invalid/db'* ]] || exit 97
crash_pause() {
  if [ "${CRASH_PHASE:-}" = "$1" ]; then
    touch "$FIXTURE/crash-ready"
    while :; do sleep 0.1; done
  fi
}
if [ "$1" = rm ]; then
  [[ "${!#}" =~ ^gachipad-migrate-[a-f0-9]{32}-(copy|preflight|image|users|checkpoint)$ ]] || exit 98
  [ "${FAIL_CONTAINER_REMOVE:-0}" = 0 ] || exit 1
  echo container-removed >>"$FIXTURE/events"
  touch "$FIXTURE/container-removed"
  exit 0
fi
if [ "$1" = container ]; then
  [ "${FAIL_CONTAINER_REMOVE:-0}" = 0 ] || echo owned-container
  exit 0
fi
if [ "$1" = volume ]; then
  case "$2" in
    ls)
      find "$FIXTURE/volumes" -type f -exec basename {} \;
      if [ "${MANY_VOLUMES:-0}" = 1 ]; then awk 'BEGIN { for (i=0; i<20000; i++) print "unrelated-volume-" i }'; fi
      ;;
    create)
      name="${!#}"; token=""
      for arg in "$@"; do case "$arg" in gachipad.migration=*) token="${arg#*=}" ;; esac; done
      [ -f "$FIXTURE/volumes/$name" ] || printf 'created %s\n' "$token" >"$FIXTURE/volumes/$name"
      [ "${RACE_VOLUME:-0}" = 0 ] || echo 'raced foreign' >"$FIXTURE/volumes/$name"
      ;;
    inspect)
      [ "${FAIL_INSPECT:-0}" = 0 ] || exit 1
      [ -f "$FIXTURE/volumes/${!#}" ] || exit 1
      [ "${3:-}" != --format ] || cat "$FIXTURE/volumes/${!#}"
      ;;
    rm) rm "$FIXTURE/volumes/$3"; echo volume-removed >>"$FIXTURE/events" ;;
  esac
  exit 0
fi
if [ "$1" = run ]; then
  [ "${GACHIPAD_REQUIRED_BYTES:-}" = "" ] || exit 0
  if [ "${DEST_NONEMPTY:-0}" = 1 ]; then printf nonempty; else printf empty; fi
  exit 0
fi
[ "$1" = compose ] || exit 0
shift
file=.env
if [ "${1:-}" = --env-file ]; then file="$2"; shift 2; fi
kind="$(sed -n 's/^GACHIPAD_DB=//p' "$file")"
printf '%s:%s\n' "$kind" "$1" >>"$FIXTURE/events"
if [[ "$*" == *'npm run --silent copy-db'* ]]; then
  [[ "$*" != *'private@'* && "$*" != *'.invalid/db'* ]] || exit 97
  [ -n "${GACHIPAD_COPY_FROM:-}" ] && [ -n "${GACHIPAD_COPY_TO:-}" ] || exit 96
  cmp .env "$FIXTURE/before.env" || exit 95
  cmp state/database-kind "$FIXTURE/before.kind" || exit 94
  [ -f "$FIXTURE/stopped" ] || exit 93
  [ -f "$FIXTURE/backup" ] || exit 92
  [ "${GACHIPAD_COPY_WINDOW_MINUTES:-}" = "${EXPECTED_WINDOW:-15}" ] || exit 91
  if [ "${COPY_WAIT:-0}" = 1 ]; then
    trap '' HUP INT TERM
    touch "$FIXTURE/copy-ready"
    for _ in {1..400}; do [ ! -f "$FIXTURE/container-removed" ] || break; sleep 0.05; done
    [ -f "$FIXTURE/container-removed" ] || exit 90
    echo copy-ended >>"$FIXTURE/events"
    exit 143
  fi
  crash_pause copy
  case "$kind" in
    sqlite) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_gachipad-data" ;;
    postgres) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data" ;;
    mongodb) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_mongo-data" ;;
  esac
  if [ "${REPLACE_VOLUME:-0}" = 1 ]; then echo 'replaced foreign' >"$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data"; fi
  echo 'shares: 1'
  if [ "${COPY_STATUS:-0}" = 0 ]; then echo 'Result: success.'
  elif [ "${COPY_NOT_WRITTEN:-0}" = 1 ]; then echo "Result: failed${COPY_FAILURE_CODE- (CONNECT)}; nothing was copied."
  elif [ -n "${COPY_REFUSAL:-}" ]; then echo "Result: refused ($COPY_REFUSAL)."
  elif [ "${COPY_STATUS:-0}" = 2 ] && [ "${COPY_WRAPPER_ERROR:-0}" = 0 ]; then echo 'Result: refused (Destination is not empty).';
  else echo 'Result: failed; drop the destination before retrying.'; fi
  exit "${COPY_STATUS:-0}"
fi
if [[ "$*" == *' api node --input-type=module -'* ]]; then
  cat >"$FIXTURE/checkpoint-source"
  grep -q 'PRAGMA wal_checkpoint(TRUNCATE)' "$FIXTURE/checkpoint-source" || exit 87
  [ -f "$FIXTURE/stopped" ] && [ ! -f "$FIXTURE/backup" ] || exit 86
  echo checkpoint >>"$FIXTURE/events"
  if [ "${CHECKPOINT_WAIT:-0}" = 1 ]; then
    trap '' HUP INT TERM
    touch "$FIXTURE/checkpoint-ready"
    for _ in {1..400}; do [ ! -f "$FIXTURE/container-removed" ] || break; sleep 0.05; done
    exit 143
  fi
  [ "${FAIL_CHECKPOINT:-0}" = 0 ] || exit 1
  exit 0
fi
if [[ "$*" == *' api node --import '* ]]; then
  cat >"$FIXTURE/preflight-source"
  grep -q '^const watchdog = setTimeout' "$FIXTURE/preflight-source" || exit 89
  crash_pause preflight
  echo preflight >>"$FIXTURE/events"
  echo 'migrate-db: required local disk space: 67108864 bytes'
  if [ "${PREFLIGHT_STATUS:-0}" = 2 ]; then echo 'Result: refused (Destination is not empty).'; fi
  exit "${PREFLIGHT_STATUS:-0}"
fi
if [[ "$*" == *' api node -e '* ]] && [ "${FAIL_CLI:-0}" = 1 ]; then exit 1; fi
if [[ "$*" == *' -T mongo-users'* ]] && [ "${FAIL_USERS:-0}" = 1 ]; then exit 1; fi
if [ "$1" = rm ]; then echo "$kind:remove:${*:2}" >>"$FIXTURE/events"; fi
if [ "$1" = stop ]; then echo "$kind:stopped-target" >>"$FIXTURE/events"; fi
if [ "$1" = up ]; then
  if [[ "$*" == *'postgres'* || "$*" == *'mongo'* ]]; then [ -f "$FIXTURE/stopped" ] || exit 88; fi
  if [ "${FAIL_TARGET_START:-0}" = 1 ] && [[ "$*" != *'api collab'* ]] && [ "$kind" != "$(cat "$FIXTURE/before.kind")" ]; then exit 1; fi
  case " $* " in
    *' postgres '*) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data" ;;
    *' mongo '*) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_mongo-data" ;;
  esac
  if [ "${FAIL_HEALTH:-0}" = 1 ] && [ "$kind" != "$(cat "$FIXTURE/before.kind")" ] && [[ "$*" == *'api collab'* ]]; then exit 1; fi
  if [[ "$*" == *'api collab'* ]]; then printf '%s\n' "$kind" >"$FIXTURE/running"; fi
fi
DOCKER
cat >"$F/bin/sync" <<'SYNC'
#!/usr/bin/env bash
set -euo pipefail
if [ "${CRASH_PHASE:-}" = publish ] && grep -qx phase=copy state/transaction.tmp; then
  touch "$FIXTURE/crash-ready"
  while :; do sleep 0.1; done
fi
exec /usr/bin/sync "$@"
SYNC
chmod +x "$F/bin/docker" "$F/bin/sync"
BASE_PATH="$PATH"
export PATH="$F/bin:$PATH" COMPOSE_PROJECT_NAME=gp-dbdeploy-fixture
make_fixture() {
  FIXTURE="$F/$1"
  export FIXTURE
  mkdir -p "$FIXTURE/install/state" "$FIXTURE/volumes"
  : >"$FIXTURE/run.log"
  cp "$ROOT"/deploy/{install.sh,preflight.sh,backup.sh,restore.sh,update.sh,upgrade.sh,migrate-db.sh,lib.sh,generate-secrets.sh,.env.example} "$FIXTURE/install/"
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
  sed -n 's/^GACHIPAD_VERSION=//p' "$FIXTURE/install/.env" >"$FIXTURE/install/VERSION"
  cp -p "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cp -p "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  printf '%s\n' "$2" >"$FIXTURE/running"
  # Keep transaction tests independent of database binaries and network health.
  cat >>"$FIXTURE/install/lib.sh" <<'LIB'
# shellcheck disable=SC2317 # sourced by migration entrypoint
crash_pause() {
  if [ "${CRASH_PHASE:-}" = "$1" ]; then
    touch "$FIXTURE/crash-ready"
    while :; do sleep 0.1; done
  fi
}
# shellcheck disable=SC2317
need_docker() { :; }
# shellcheck disable=SC2317
database_backup() { crash_pause backup; [ "${FAIL_BACKUP:-0}" = 0 ] || return 1; touch "$FIXTURE/backup"; echo backup >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
stop_writes() { if [ "${FAIL_STOP:-0}" = 1 ] && [ "${1:-}" != restore ]; then return 1; fi; touch "$FIXTURE/stopped"; echo stopped >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
database_start() { if [ "${FAIL_RECOVERY:-0}" = 1 ] && [ "$(database_kind)" = "$(cat "$FIXTURE/before.kind")" ]; then return 1; fi; echo start >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
wait_api() { crash_pause switch; }
# shellcheck disable=SC2317
wait_healthy() { crash_pause live; [ "${FAIL_INGRESS:-0}" = 0 ] || return 1; }
LIB
}
run() { (cd "$FIXTURE/install" && ./migrate-db.sh "$@") >"$FIXTURE/run.log" 2>&1; }
clean_state() {
  [ ! -e "$FIXTURE/install/state/transaction" ]
  [ ! -e "$FIXTURE/install/state/install.lock.d" ]
  [ -z "$(find "$FIXTURE/install" -maxdepth 1 -name '.env.migrate-db.*')" ]
  if grep -Eq 'private@|[a-zA-Z][a-zA-Z0-9+.-]*://' "$FIXTURE/run.log"; then exit 1; fi
  if [ -f "$FIXTURE/install/state/migrate-db.log" ] &&
    grep -Eq 'private@|[a-zA-Z][a-zA-Z0-9+.-]*://' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
}
for pair in mongodb:sqlite sqlite:postgres postgres:external sqlite:mongodb external:postgres; do
  from="${pair%:*}"; to="${pair#*:}"
  make_fixture "success-$from-$to" "$from"
  args=(--to "$to" --yes)
  if [ "$to" = external ]; then export DATABASE_URL='postgresql://fixture:private@target.invalid/db'; fi
  GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1 run "${args[@]}"
  unset DATABASE_URL
  [ "$(cat "$FIXTURE/install/state/database-kind")" = "$to" ]
  [ "$(cat "$FIXTURE/running")" = "$to" ]
  case "$to" in
    postgres) grep -qx 'COMPOSE_PROFILES=mdns,postgres' "$FIXTURE/install/.env"; grep -Eq '^POSTGRES_PASSWORD=.+$' "$FIXTURE/install/.env" ;;
    mongodb) grep -qx 'COMPOSE_PROFILES=mdns,mongodb' "$FIXTURE/install/.env" ;;
    *) grep -qx 'COMPOSE_PROFILES=mdns' "$FIXTURE/install/.env" ;;
  esac
  grep -q 'previous backend data and backups are kept' "$FIXTURE/run.log"
  if grep -q 'volume-removed' "$FIXTURE/events"; then exit 1; fi
  if [ "$from" != sqlite ] && grep -qx checkpoint "$FIXTURE/events"; then exit 1; fi
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
  if [ "$status" = 2 ]; then
    grep -q 'destination was not modified: refused' "$FIXTURE/install/state/migrate-db.log"
    if grep -q 'inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
  else grep -q 'destination may hold a partial copy' "$FIXTURE/install/state/migrate-db.log"; fi
  clean_state
  echo "ok: copy exit $status survives npm invocation; old backend runs; new volume removed"
done
make_fixture checkpoint-failed sqlite
if FAIL_CHECKPOINT=1 run --to postgres --yes; then exit 1; fi
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
[ "$(cat "$FIXTURE/running")" = sqlite ]
[ ! -e "$FIXTURE/backup" ]
if grep -q '^postgres:up$' "$FIXTURE/events"; then exit 1; fi
grep -q 'SQLite source checkpoint failed, timed out or -wal/-shm files remain' "$FIXTURE/install/state/migrate-db.log"
clean_state
echo 'ok: SQLite checkpoint failure prevents backup/copy and target startup; recovers source'
make_fixture checkpoint-order sqlite
run --to postgres --yes
python3 - "$FIXTURE/events" <<'ORDER'
import pathlib, sys
events = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert events.index("stopped") < events.index("checkpoint") < events.index("backup") < events.index("postgres:run", events.index("backup"))
ORDER
clean_state
echo 'ok: SQLite checkpoint runs after writers stop and before backup/copy'
refusal_case=0
for refusal in 'SQLite source is open elsewhere or was not closed cleanly' 'SQLite source must be a regular file' 'SQLite source path changed during the copy' 'SQL source schema version is missing or not supported' 'MongoDB source is not the primary' 'Audit details are not plain JSON in 1 record'; do
  refusal_case=$((refusal_case + 1))
  make_fixture "source-refused-$refusal_case" sqlite
  if COPY_STATUS=2 COPY_REFUSAL="$refusal" run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
  grep -q 'source refused .*nothing was copied' "$FIXTURE/install/state/migrate-db.log"
  if grep -Eq 'use an empty destination|destination may hold a partial copy|inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  [ "$(cat "$FIXTURE/running")" = sqlite ]
  clean_state
done
echo 'ok: source copy refusals retain exit 2 and give source-only recovery guidance'
make_fixture generic-refused sqlite
if COPY_STATUS=2 COPY_REFUSAL='Unsupported database URL scheme (supported: memory, mongodb, mongodb+srv, sqlite, postgres, postgresql, mysql, mariadb)' run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
grep -q 'copy refused before writing' "$FIXTURE/install/state/migrate-db.log"
if grep -Eq 'use an empty destination|destination may hold a partial copy' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
clean_state
echo 'ok: unclassified copy refusal gives neutral recovery guidance'
make_fixture checkpoint-finished sqlite
if FAIL_BACKUP=1 FAIL_CONTAINER_REMOVE=1 run --to postgres --yes; then exit 1; else [ "$?" = 1 ]; fi
if grep -q container-removed "$FIXTURE/events"; then exit 1; fi
[ "$(cat "$FIXTURE/running")" = sqlite ]
clean_state
echo 'ok: completed checkpoint clears its container name before backup recovery'
make_fixture checkpoint-timeout sqlite
# Shorten only the production deadline in this fixture, leaving real timeout semantics intact.
sed -i 's/--kill-after=5s 180s/--kill-after=1s 1s/' "$FIXTURE/install/migrate-db.sh"
checkpoint_started=$SECONDS
if CHECKPOINT_WAIT=1 run --to postgres --yes; then exit 1; else [ "$?" = 1 ]; fi
[ "$((SECONDS - checkpoint_started))" -le 5 ]
[ -f "$FIXTURE/checkpoint-ready" ]
[ -f "$FIXTURE/container-removed" ]
[ ! -e "$FIXTURE/backup" ]
[ "$(cat "$FIXTURE/running")" = sqlite ]
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
python3 - "$FIXTURE/events" <<'TIMEOUT'
import pathlib, sys
events = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert events.index("container-removed") < events.index("start")
TIMEOUT
clean_state
echo 'ok: checkpoint wall-clock timeout removes container before source recovery'
make_fixture checkpoint-signal sqlite
CHECKPOINT_WAIT=1 python3 - <<'CHECKPOINT_SIGNAL'
import os, pathlib, signal, subprocess, time
root = pathlib.Path(os.environ["FIXTURE"])
with (root / "run.log").open("w") as log:
    p = subprocess.Popen(["./migrate-db.sh", "--to", "postgres", "--yes"],
        cwd=root / "install", stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while not (root / "checkpoint-ready").exists() and time.monotonic() < deadline:
            assert p.poll() is None, "checkpoint never started"
            time.sleep(0.05)
        assert (root / "checkpoint-ready").exists()
        p.send_signal(signal.SIGTERM)
        assert p.wait(timeout=10) == 143
        events = (root / "events").read_text().splitlines()
        assert events.index("container-removed") < events.index("start")
        assert not (root / "backup").exists()
    finally:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
CHECKPOINT_SIGNAL
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
[ "$(cat "$FIXTURE/running")" = sqlite ]
clean_state
echo 'ok: signal during checkpoint removes container before source recovery'
make_fixture existing-destination sqlite
touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
if DEST_NONEMPTY=1 run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
[ ! -e "$FIXTURE/backup" ]
[ ! -e "$FIXTURE/stopped" ]
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
clean_state
echo 'ok: refused existing destination volume is retained'
make_fixture many-volumes sqlite
touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
if MANY_VOLUMES=1 DEST_NONEMPTY=1 run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
[ ! -e "$FIXTURE/stopped" ]; [ ! -e "$FIXTURE/backup" ]
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
clean_state
echo 'ok: existing volume detection works beyond a pipe buffer with ignored PIPE'
make_fixture failed-health mongodb
if FAIL_HEALTH=1 run --to postgres --yes; then exit 1; fi
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
[ "$(cat "$FIXTURE/running")" = mongodb ]
cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
[ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
grep -q 'postgres:stopped-target' "$FIXTURE/events"
clean_state
echo 'ok: failed target startup restores source configuration and marker'
make_fixture external-identical external
if DATABASE_URL='postgresql://fixture:private@source.invalid/db' run --to external --yes; then exit 1; fi
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
for flag in FAIL_BACKUP FAIL_STOP FAIL_TARGET_START FAIL_USERS FAIL_CLI; do
  make_fixture "$flag" sqlite
  target=postgres; [ "$flag" != FAIL_USERS ] || target=mongodb
  # shellcheck disable=SC2016 # expanded by the fixture shell
  if env "$flag=1" bash -c 'cd "$FIXTURE/install"; ./migrate-db.sh --to "$1" --yes' _ "$target" >"$FIXTURE/run.log" 2>&1; then exit 1; fi
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  [ "$(cat "$FIXTURE/running")" = sqlite ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_mongo-data" ]
  clean_state
  echo "ok: $flag restores config/marker and removes only its own target"
done
for failure in inspect race; do
  make_fixture "$failure" sqlite
  if [ "$failure" = inspect ]; then
    touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
    if FAIL_INSPECT=1 run --to postgres --yes; then exit 1; fi
  else
    if RACE_VOLUME=1 run --to postgres --yes; then exit 1; fi
  fi
  [ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
  [ ! -e "$FIXTURE/backup" ]; [ ! -e "$FIXTURE/stopped" ]
  clean_state
  echo "ok: $failure cannot authorize deleting a pre-existing or concurrent volume"
done
for status in 1 2; do
  make_fixture "preflight-$status" sqlite
  if PREFLIGHT_STATUS="$status" run --to postgres --yes; then exit 1; else [ "$?" = "$status" ]; fi
  [ ! -e "$FIXTURE/backup" ]; [ ! -e "$FIXTURE/stopped" ]
  clean_state
  echo "ok: preflight exit $status refuses before downtime"
done
make_fixture empty-existing sqlite
touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
if PREFLIGHT_STATUS=1 run --to postgres --yes; then exit 1; fi
[ ! -s "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
[ ! -e "$FIXTURE/stopped" ]; [ ! -e "$FIXTURE/backup" ]
if grep -Eq 'postgres:(up|stop|rm)' "$FIXTURE/events"; then exit 1; fi
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
clean_state
run --to postgres --yes
[ "$(cat "$FIXTURE/running")" = postgres ]
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
clean_state
echo 'ok: failed preflight leaves existing empty target unchanged and retry succeeds'
make_fixture sqlite-partial mongodb
if COPY_STATUS=1 run --to sqlite --yes; then exit 1; fi
grep -q 'SQLite destination files are /data/gachipad.db' "$FIXTURE/install/state/migrate-db.log"
clean_state
make_fixture mongo-partial sqlite
if COPY_STATUS=1 run --to mongodb --yes; then exit 1; fi
grep -qx 'mongodb:remove:-sfv mongo-users mongo' "$FIXTURE/events"
[ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_mongo-data" ]
clean_state
echo 'ok: SQLite partial hint and MongoDB container/anonymous volume cleanup are covered'
make_fixture wrapper-exit-2 sqlite
if COPY_STATUS=2 COPY_WRAPPER_ERROR=1 run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
if grep -q 'destination was not modified' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
grep -q 'destination may hold a partial copy' "$FIXTURE/install/state/migrate-db.log"
clean_state
echo 'ok: wrapper exit 2 does not claim the copy tool refused safely'
make_fixture missing-tee sqlite
cat >"$F/bin/tee" <<'TEE'
#!/usr/bin/env bash
exit 1
TEE
chmod +x "$F/bin/tee"
if run --to postgres --yes; then exit 1; fi
rm "$F/bin/tee"
grep -q 'tee with -p support is required' "$FIXTURE/run.log"
[ ! -e "$FIXTURE/stopped" ]; [ ! -e "$FIXTURE/backup" ]
clean_state
echo 'ok: missing tee -p refuses before downtime'
make_fixture replaced-volume sqlite
if COPY_STATUS=1 REPLACE_VOLUME=1 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
grep -q 'identity could not be verified' "$FIXTURE/install/state/migrate-db.log"
[ -e "$FIXTURE/install/state/transaction" ]
echo 'ok: changed volume identity prevents removal during rollback'
# An external URL must be supplied through the environment, and failure before writes is distinct.
failure_case=0
for code in ' (CONNECT)' '' ' (took longer than 10 minutes)'; do
  failure_case=$((failure_case + 1))
  make_fixture "nothing-written-$failure_case" sqlite
  if DATABASE_URL='postgresql://fixture:private@target.invalid/db' COPY_STATUS=1 COPY_NOT_WRITTEN=1 COPY_FAILURE_CODE="$code" run --to external --yes; then exit 1; else [ "$?" = 1 ]; fi
  grep -q 'destination was not modified; nothing was copied' "$FIXTURE/install/state/migrate-db.log"
  if grep -Eq 'inspect and clear|use an empty destination|drop the destination' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  [ "$(cat "$FIXTURE/running")" = sqlite ]
  clean_state
done
echo 'ok: coded and generic pre-write failures retain exit 1 without destination deletion advice'
make_fixture ingress-opened sqlite
if FAIL_INGRESS=1 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
grep -q 'new backend may have accepted writes; destination retained' "$FIXTURE/install/state/migrate-db.log"
if grep -q 'inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
# Recovery health is also failed here, so snapshots must remain.
[ -e "$FIXTURE/install/state/transaction" ]
echo 'ok: ingress-opened failure retains destination writes and snapshots'
make_fixture ingress-recovery-failed sqlite
if FAIL_INGRESS=1 FAIL_RECOVERY=1 run --to postgres --yes; then exit 1; else [ "$?" = 3 ]; fi
cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
grep -qx phase=live "$FIXTURE/install/state/transaction"
stage="$(sed -n 's/^snapshot=//p' "$FIXTURE/install/state/transaction")"
if cmp -s "$FIXTURE/install/.env" "$FIXTURE/install/$stage/.env"; then exit 1; else [ "$?" = 1 ]; fi
grep -Fq "cmp -s .env $stage/.env" "$FIXTURE/install/state/migrate-db.log"
grep -q 'old backend was restored; treat as rollback and reconcile destination writes' "$FIXTURE/install/state/migrate-db.log"
grep -q 'on exit 1, restart the restored backend' "$FIXTURE/install/state/migrate-db.log"
if grep -q 'marker may be stale' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
if grep -q 'rm -sf postgres' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
echo 'ok: ingress and source-restart failure returns 3; live recipe identifies restored source configuration'
make_fixture incomplete sqlite
if COPY_STATUS=1 FAIL_RECOVERY=1 run --to postgres --yes; then exit 1; else [ "$?" = 3 ]; fi
[ -e "$FIXTURE/install/state/transaction" ]
[ -n "$(find "$FIXTURE/install" -maxdepth 1 -name '.env.migrate-db.*')" ]
grep -q 'live configuration and backend marker are unchanged' "$FIXTURE/install/state/migrate-db.log"
grep -q 'only after recovery succeeds' "$FIXTURE/install/state/migrate-db.log"
[ ! -e "$FIXTURE/install/state/install.lock.d" ]
echo 'ok: incomplete recovery preserves snapshots/transaction and gives concrete commands'
make_fixture container-removal-failed sqlite
if COPY_STATUS=1 FAIL_CONTAINER_REMOVE=1 run --to postgres --yes; then exit 1; else [ "$?" = 3 ]; fi
if grep -qx start "$FIXTURE/events"; then exit 1; fi
grep -q 'writers stay stopped' "$FIXTURE/install/state/migrate-db.log"
[ -e "$FIXTURE/install/state/transaction" ]
echo 'ok: unverified copy container removal prevents source restart and returns exit 3'
for signal_target in HUP:postgres INT:sqlite TERM:external; do
  signal="${signal_target%:*}"; target="${signal_target#*:}"
  make_fixture "signal-$signal" mongodb
  # Python avoids the ignored SIGINT disposition of a shell background job. Close both
  # the output reader and stderr, modelling tee/SSH loss while the copy is running.
  if [ "$target" = external ]; then export DATABASE_URL='postgresql://fixture:private@target.invalid/db'; fi
  COPY_WAIT=1 python3 - "$signal" "$target" <<'SIGNAL'
import os, pathlib, re, signal, subprocess, sys, time
root = pathlib.Path(os.environ["FIXTURE"])
p = subprocess.Popen(["./migrate-db.sh", "--to", sys.argv[2], "--yes"],
    cwd=root / "install", stdout=subprocess.PIPE, preexec_fn=lambda: os.close(2),
    start_new_session=True)
p.stdout.close()
try:
    for _ in range(200):
        if (root / "copy-ready").exists(): break
        if p.poll() is not None: raise AssertionError("copy never started")
        time.sleep(0.05)
    assert (root / "copy-ready").exists()
    sig = getattr(signal, "SIG" + sys.argv[1])
    p.send_signal(sig)
    deadline = time.monotonic() + 1
    while not (root / "container-removed").exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert (root / "container-removed").exists(), "signal did not stop copy within one second"
    assert p.wait(timeout=10) == 128 + sig
    events = (root / "events").read_text().splitlines()
    assert events.index("container-removed") < events.index("start")
    log = (root / "install/state/migrate-db.log").read_text()
    assert "migration container stopped and removed before recovery" in log
    assert "previous configuration restored and old backend retained" in log
    assert "destination may hold a partial copy" in log
    assert "private@" not in log and "://" not in log
    for line in (root / "before.env").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and re.search("SECRET|PASSWORD|TOKEN|PRIVATE_KEY", key) and len(value) > 8:
            assert value not in log, "private log contains a configured secret"
    assert (root / "install/state/migrate-db.log").stat().st_mode & 0o777 == 0o600
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
SIGNAL
  unset DATABASE_URL
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  [ "$(cat "$FIXTURE/running")" = mongodb ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_gachipad-data" ]
  clean_state
  echo "ok: $signal with closed stderr/dead output pipe recovers and releases snapshots/lock"
done
make_fixture legacy-source mongodb
(cd "$FIXTURE/install"; . ./lib.sh; env_set GACHIPAD_LEGACY_INSTALL 1; env_set MONGO_DATABASE codesh; ./generate-secrets.sh >/dev/null)
cp -p "$FIXTURE/install/.env" "$FIXTURE/before.env"
COMPOSE_PROJECT_NAME=codesh EXPECTED_WINDOW=20 run --to postgres --window-minutes 20 --yes
grep -qx 'MONGO_DATABASE=codesh' "$FIXTURE/install/.env"
grep -qx 'GACHIPAD_LEGACY_INSTALL=0' "$FIXTURE/install/.env"
grep -qx 'COMPOSE_PROFILES=mdns,postgres' "$FIXTURE/install/.env"
clean_state
echo 'ok: legacy codesh project/Mongo namespace preserved; target clears legacy pin; window 20 passed by env'
for window in 14 1441 15.5 abc; do
  make_fixture "window-$window" sqlite
  if run --to postgres --window-minutes "$window" --yes; then exit 1; fi
  [ ! -e "$FIXTURE/backup" ]; clean_state
done
echo 'ok: invalid windows refuse before downtime'
make_fixture malformed-url sqlite
if DATABASE_URL='postgres:foo' run --to external --yes; then exit 1; fi
grep -q 'requires a server scheme' "$FIXTURE/run.log"
[ ! -e "$FIXTURE/backup" ]; clean_state
echo 'ok: malformed server URL refuses before downtime without printing its value'
# SIGKILL bypasses EXIT recovery: all entrypoints must preserve the crash evidence.
for crash in preflight:postgres backup:postgres copy:postgres switch:postgres live:postgres publish:postgres copy:mongodb; do
  phase="${crash%:*}"; target="${crash#*:}"
  make_fixture "crash-$phase-$target" sqlite
  CRASH_PHASE="$phase" CRASH_TARGET="$target" python3 - <<'CRASH'
import os, pathlib, signal, subprocess, time
root = pathlib.Path(os.environ["FIXTURE"])
with (root / "run.log").open("w") as log:
    target = os.environ["CRASH_TARGET"]
    p = subprocess.Popen(["./migrate-db.sh", "--to", target, "--yes"],
        cwd=root / "install", stdout=log, stderr=log, start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while not (root / "crash-ready").exists() and time.monotonic() < deadline:
            assert p.poll() is None, "phase never reached"
            time.sleep(0.02)
        assert (root / "crash-ready").exists()
        marker = (root / "install/state/transaction").read_text()
        expected = "backup" if os.environ["CRASH_PHASE"] == "publish" else os.environ["CRASH_PHASE"]
        assert "phase=" + expected + "\n" in marker
        if expected == "live":
            assert (root / "running").read_text().strip() == "postgres"
        if os.environ["CRASH_PHASE"] == "publish":
            assert "phase=copy\n" in (root / "install/state/transaction.tmp").read_text()
        assert "source=sqlite\n" in marker
        assert "destination=" + target + "\n" in marker
        assert (root / "install/state/transaction").stat().st_mode & 0o777 == 0o600
        suffix = "postgres-data" if target == "postgres" else "mongo-data"
        assert "volume=gp-dbdeploy-fixture_" + suffix + "\n" in marker
    finally:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
CRASH
  expected_phase="$phase"
  [ "$phase" != publish ] || expected_phase=backup
  for command in install backup restore update upgrade; do
    # The crash leaves the actual dead migration owner's mkdir lock behind.
    printf 'private fixture log\n' >"$FIXTURE/install/state/update.log"
    cp "$FIXTURE/events" "$FIXTURE/events-before"
    (cd "$FIXTURE/install"; find . -type f -exec sha256sum {} + | sort) >"$FIXTURE/files-before"
    chmod 700 "$FIXTURE/install/state"
    if (cd "$FIXTURE/install"; "./$command.sh" --yes) >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 1 ]; fi
    grep -q 'unfinished or running database migration.*recovery recipe' "$FIXTURE/refusal.log"
    if [ "$phase" != live ]; then grep -q 'remove any surviving one-off containers' "$FIXTURE/refusal.log"; fi
    if [ "$target" = postgres ]; then suffix=postgres-data; else suffix=mongo-data; fi
    grep -q "destination volume to inspect.*gp-dbdeploy-fixture_$suffix" "$FIXTURE/refusal.log"
    grep -q 'state/transaction.tmp' "$FIXTURE/refusal.log"
    if [ "$phase" != live ]; then
      grep -Eq 'docker volume ls -q --filter label=gachipad.migration=[a-f0-9]{32}$' "$FIXTURE/refusal.log"
      grep -q 'only exit 0 proves emptiness' "$FIXTURE/refusal.log"
      grep -Fq "docker volume inspect gp-dbdeploy-fixture_$suffix >/dev/null && docker run" "$FIXTURE/refusal.log"
    fi
    if [ "$phase" = preflight ] || [ "$phase" = live ]; then
      if grep -Eq 'keep writers stopped|restore configuration:|restart the saved backend' "$FIXTURE/refusal.log"; then exit 1; fi
    else grep -q 'keep writers stopped' "$FIXTURE/refusal.log"; fi
    case "$expected_phase" in
      backup | copy) if grep -q 'restore configuration:' "$FIXTURE/refusal.log"; then exit 1; fi ;;
    esac
    case "$expected_phase" in
      backup) grep -q 'startup may have initialized' "$FIXTURE/refusal.log" ;;
      copy) grep -q 'partial copy' "$FIXTURE/refusal.log" ;;
      switch) grep -q 'retain and reconcile' "$FIXTURE/refusal.log" ;;
      live) grep -q 'roll forward first: docker compose ps; check /healthz' "$FIXTURE/refusal.log"; grep -q 'If it exits 1, do not clear the marker yet' "$FIXTURE/refusal.log"; grep -q 'rollback requires reconciling writes' "$FIXTURE/refusal.log" ;;
    esac
    case "$phase" in
      preflight | live) if grep -q 'rm -sf postgres' "$FIXTURE/refusal.log"; then exit 1; fi ;;
      *)
        if [ "$target" = postgres ]; then grep -q 'rm -sf postgres' "$FIXTURE/refusal.log"
        else grep -q 'rm -sfv mongo-users mongo' "$FIXTURE/refusal.log"; fi
        ;;
    esac
    (cd "$FIXTURE/install"; find . -type f -exec sha256sum {} + | sort) >"$FIXTURE/files-after"
    cmp "$FIXTURE/files-before" "$FIXTURE/files-after"
    cmp "$FIXTURE/events-before" "$FIXTURE/events"
    [ "$(stat -c %a "$FIXTURE/install/state")" = 700 ]
    if grep -Eq 'private@|[a-zA-Z][a-zA-Z0-9+.-]*://' "$FIXTURE/refusal.log"; then exit 1; fi
  done
  echo "ok: SIGKILL during $phase to $target retains phase; all five commands refuse without changes"
done
# An older marker without phase metadata still gets conservative restoration guidance.
make_fixture crash-legacy mongodb
mkdir "$FIXTURE/install/.env.migrate-db.legacy"
cp "$FIXTURE/before.env" "$FIXTURE/install/.env.migrate-db.legacy/original.env"
printf 'database migration\nsnapshot=.env.migrate-db.legacy\n' >"$FIXTURE/install/state/transaction"
(cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
grep -q 'keep writers stopped' "$FIXTURE/refusal.log"
grep -q 'restore configuration:' "$FIXTURE/refusal.log"
grep -q 'rm -f state/database-kind' "$FIXTURE/refusal.log"
for recipe_target in sqlite external mongodb; do
  printf 'database migration\nsnapshot=.env.migrate-db.legacy\nphase=copy\ndestination=%s\n' "$recipe_target" >"$FIXTURE/install/state/transaction"
  (cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
  case "$recipe_target" in
    sqlite) grep -q '/data/gachipad.db-wal and /data/gachipad.db-shm' "$FIXTURE/refusal.log" ;;
    external) grep -q 'external destination selected in .env.migrate-db.legacy/.env' "$FIXTURE/refusal.log" ;;
    mongodb) grep -q 'rm -sfv mongo-users mongo' "$FIXTURE/refusal.log" ;;
  esac
done
printf 'database migration\nsnapshot=.env.migrate-db.missing\nphase=preflight\n' >"$FIXTURE/install/state/transaction"
(cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
if grep -Eq 'keep writers stopped|restore configuration:|restart the saved backend|restore it' "$FIXTURE/refusal.log"; then exit 1; fi
echo 'ok: legacy markers, missing preflight snapshots and SQLite/external/MongoDB cleanup recipes'
# SQLite is the shared uploads volume, never a volume-removal candidate in any phase.
for recipe_phase in preflight backup copy switch live; do
  printf 'database migration\nsnapshot=.env.migrate-db.legacy\nphase=%s\ndestination=sqlite\nvolume=fixture_gachipad-data\n' "$recipe_phase" >"$FIXTURE/install/state/transaction"
  (cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
  grep -q 'preserve the volume, uploads and all other files' "$FIXTURE/refusal.log"
  grep -q '/data/gachipad.db-wal and /data/gachipad.db-shm' "$FIXTURE/refusal.log"
  if grep -Eq 'before removing it|volume rm|startup may have initialized|empty destination volume' "$FIXTURE/refusal.log"; then exit 1; fi
  printf 'database migration\nsnapshot=.env.migrate-db.legacy\nphase=%s\ndestination=external\n' "$recipe_phase" >"$FIXTURE/install/state/transaction"
  (cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
  case "$recipe_phase" in switch | live) grep -q 'do not remove the snapshot until writes since the switch are reconciled' "$FIXTURE/refusal.log" ;; esac
done
# Hostile and duplicate metadata is never printed as a shell command or interpreted.
for metadata in 'run=not-hex;touch hostile' 'snapshot=../x' 'snapshot=.env.migrate-db.bad name' \
  $'snapshot=.env.migrate-db.legacy\nsnapshot=../x' $'snapshot=.env.migrate-db.legacy\ninvalid-line' \
  'volume=bad;touch hostile' $'volume=fixture_postgres-data\nvolume=bad;touch hostile' \
  $'run=0123456789abcdef0123456789abcdef\nrun=evil'; do
  case "$metadata" in
    snapshot=*) printf 'database migration\nphase=copy\ndestination=postgres\n%s\n' "$metadata" ;;
    *) printf 'database migration\nsnapshot=.env.migrate-db.legacy\nphase=copy\ndestination=postgres\n%s\n' "$metadata" ;;
  esac >"$FIXTURE/install/state/transaction"
  (cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
  if grep -Eq 'touch hostile|not-hex|snapshot=|bad name|run=evil|\.\./x' "$FIXTURE/refusal.log"; then exit 1; fi
  case "$metadata" in
    *$'\nsnapshot='*) if grep -q 'rm -rf' "$FIXTURE/refusal.log"; then exit 1; fi ;;
    *$'\nrun='*) if grep -q 'gachipad-migrate-' "$FIXTURE/refusal.log"; then exit 1; fi ;;
    *$'\nvolume='*) if grep -q 'destination volume to inspect' "$FIXTURE/refusal.log"; then exit 1; fi ;;
  esac
done
printf 'database migration\nsnapshot=.env.migrate-db.bad\nname\n' >"$FIXTURE/install/state/transaction"
(cd "$FIXTURE/install"; . ./lib.sh; migration_recovery_hint "") >"$FIXTURE/refusal.log"
if grep -q 'rm -rf' "$FIXTURE/refusal.log"; then exit 1; fi
# Only a verified, current-boot migrate-db owner can suppress the crash recipe.
mkdir -p "$FIXTURE/install/state/install.lock.d"
printf 'database migration\n' >"$FIXTURE/install/state/transaction"
python3 - <<'OWNER'
import os, pathlib, signal, subprocess, time
root = pathlib.Path(os.environ["FIXTURE"])
lock = root / "install/state/install.lock.d"
boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text()
boot_time = next(int(line.split()[1]) for line in pathlib.Path("/proc/stat").read_text().splitlines()
                 if line.startswith("btime "))
script = root / "migrate-db.sh"
script.write_text('#!/usr/bin/env bash\ntouch "$FIXTURE/owner-ready"\nwhile :; do sleep 0.1; done\n')
p = subprocess.Popen(["bash", str(script)], start_new_session=True)
def hint(wait):
    result = subprocess.run(["./backup.sh"], cwd=root / "install", capture_output=True)
    assert result.returncode == 1, result.stderr
    text = result.stderr.decode()
    if wait:
        assert f"migration in progress (pid {p.pid}); wait" in text, text
        assert "docker compose" not in text, text
    else:
        assert "marker may be stale" in text, text
        assert "keep writers stopped: docker compose stop" in text, text
        assert "migration in progress" not in text, text
try:
    deadline = time.monotonic() + 5
    while not (root / "owner-ready").exists() and time.monotonic() < deadline:
        assert p.poll() is None
        time.sleep(0.01)
    assert (root / "owner-ready").exists()
    (lock / "owner").write_text(str(p.pid))
    (lock / "boot").write_text(boot)
    hint(True)
    (lock / "boot").write_text("different-boot\n")
    hint(False)
    (lock / "boot").write_text(boot)
    os.utime(lock, (boot_time - 1, boot_time - 1))
    hint(False)
    os.utime(lock, None)
    (lock / "boot").unlink()
    hint(False)
    (lock / "boot").write_text(boot)
    (lock / "owner").write_text(str(os.getpid()))
    hint(False)
finally:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
OWNER
rm -rf "$FIXTURE/install/state/install.lock.d"
for marker in '' 'database migration' 'FROM' 'unknown transaction'; do
  printf '%s' "$marker" >"$FIXTURE/install/state/transaction"
  for command in install backup restore update upgrade; do
    if (cd "$FIXTURE/install"; "./$command.sh") >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 1 ]; fi
    grep -q 'unfinished or running database migration' "$FIXTURE/refusal.log"
  done
done
# Exercise chmod 000 as an unprivileged user even when the box test runner is root.
printf 'FROM=1.0.0\nTARGET=1.1.0\nPHASE=installed\nBACKUP=backups/fixture.archive.gz\n' >"$FIXTURE/install/state/transaction"
chmod 000 "$FIXTURE/install/state/transaction"
chmod 755 "$F" "$FIXTURE" "$FIXTURE/install" "$FIXTURE/install/state"
chmod a+rX "$FIXTURE/install/"*.sh
python3 - <<'UNREADABLE'
import os, pathlib, subprocess
root = pathlib.Path(os.environ["FIXTURE"]) / "install"
def drop_root():
    if os.getuid() == 0:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
for name in ["install", "backup", "restore", "update", "upgrade"]:
    p = subprocess.run(["bash", f"./{name}.sh"], cwd=root, capture_output=True, preexec_fn=drop_root)
    assert p.returncode == 1, (name, p.stderr)
    assert b"unfinished or running database migration" in p.stderr, (name, p.stderr)
UNREADABLE
chmod 600 "$FIXTURE/install/state/transaction"
# Post-lock checks close the race for scripts that have two checks; update has one parsed check.
for command in install backup restore upgrade update; do
  make_fixture "race-$command" sqlite
  : >"$FIXTURE/install/images.tar"
  cat >>"$FIXTURE/install/lib.sh" <<'RACE'
# shellcheck disable=SC2317
verify_bundle() { :; }
# shellcheck disable=SC2317
install_lock() { printf 'database migration\n' >state/transaction; }
RACE
  if (cd "$FIXTURE/install"; "./$command.sh") >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 1 ]; fi
  grep -Eq 'unfinished or running database migration|unfinished transaction' "$FIXTURE/refusal.log"
  [ ! -f "$FIXTURE/backup" ]
done
# Leftovers before the first marker (including a torn tmp) also fail closed.
for leftover in snapshot temporary; do
  make_fixture "orphan-$leftover" sqlite
  if [ "$leftover" = snapshot ]; then mkdir "$FIXTURE/install/.env.migrate-db.orphan"
  else : >"$FIXTURE/install/state/transaction.tmp"; fi
  for command in install backup restore update upgrade; do
    if (cd "$FIXTURE/install"; "./$command.sh") >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 1 ]; fi
    grep -q 'unfinished database migration staging files.*interrupted update.*OPERATIONS 15.7' "$FIXTURE/refusal.log"
  done
done
echo 'ok: hostile, duplicate, empty, unreadable and minimal markers; verified/stale/unrelated owners; post-lock races; orphan staging'
make_fixture update-transaction sqlite
printf 'FROM=1.0.0\nTARGET=1.1.0\nPHASE=installed\nBACKUP=backups/fixture.archive.gz\n' >"$FIXTURE/install/state/transaction"
if run --to postgres --yes; then exit 1; else [ "$?" = 1 ]; fi
grep -q 'OPERATIONS 15.7' "$FIXTURE/run.log"
if grep -q 'locate the private .env.migrate-db' "$FIXTURE/run.log"; then exit 1; fi
echo 'ok: migrate-db sends updater markers to update recovery without a migration snapshot recipe'
make_fixture absent-marker sqlite
# With no migration marker, each entrypoint reaches its normal dependency/lock boundary.
rm -f "$FIXTURE/install/state/transaction"
cat >>"$FIXTURE/install/lib.sh" <<'ABSENT'
# shellcheck disable=SC2317
need_docker() { exit 77; }
# shellcheck disable=SC2317
install_lock() { exit 77; }
ABSENT
for command in install backup restore update upgrade; do
  if (cd "$FIXTURE/install"; "./$command.sh") >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 77 ]; fi
  if grep -q 'unfinished database migration' "$FIXTURE/refusal.log"; then exit 1; fi
done
# Update rollback markers continue to permit backup/restore during manual recovery.
printf 'FROM=1.0.0\nTARGET=1.1.0\nPHASE=installed\nBACKUP=backups/fixture.archive.gz\n' >"$FIXTURE/install/state/transaction"
mkdir "$FIXTURE/install/.env.migrate-db.orphan"
: >"$FIXTURE/install/state/transaction.tmp"
(cd "$FIXTURE/install"; . ./lib.sh; assert_no_database_migration)
for command in install backup restore update upgrade; do
  if (cd "$FIXTURE/install"; "./$command.sh") >"$FIXTURE/refusal.log" 2>&1; then exit 1; else [ "$?" = 77 ]; fi
  if grep -q 'unfinished database migration' "$FIXTURE/refusal.log"; then exit 1; fi
done
echo 'ok: absent migration markers allow all five entrypoints; update markers ignore migration staging and keep recovery available'
PATH="$BASE_PATH" node "$ROOT/deploy/migrate-preflight.verify.mjs"
echo 'migrate-db.test.sh: all checks passed'
