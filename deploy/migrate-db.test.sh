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
[[ "$*" != *'private@'* && "$*" != *'.invalid/db'* ]] || exit 97
if [ "$1" = volume ]; then
  case "$2" in
    ls) find "$FIXTURE/volumes" -type f -exec basename {} \; ;;
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
    touch "$FIXTURE/copy-ready"
    for _ in {1..100}; do [ ! -f "$FIXTURE/release-copy" ] || break; sleep 0.05; done
  fi
  case "$kind" in
    sqlite) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_gachipad-data" ;;
    postgres) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data" ;;
    mongodb) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_mongo-data" ;;
  esac
  if [ "${REPLACE_VOLUME:-0}" = 1 ]; then echo 'replaced foreign' >"$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data"; fi
  echo 'shares: 1'
  if [ "${COPY_STATUS:-0}" = 0 ]; then echo 'Result: success.'
  elif [ "${COPY_NOT_WRITTEN:-0}" = 1 ]; then echo 'Result: failed (CONNECT); nothing was copied.'
  else echo 'Result: refused or failed.'; fi
  exit "${COPY_STATUS:-0}"
fi
if [[ "$*" == *' api node --import '* ]]; then
  echo 'migrate-db: required local bytes 67108864'
  exit "${PREFLIGHT_STATUS:-0}"
fi
if [[ "$*" == *' api node -e '* ]] && [ "${FAIL_CLI:-0}" = 1 ]; then exit 1; fi
if [[ "$*" == *' -T mongo-users'* ]] && [ "${FAIL_USERS:-0}" = 1 ]; then exit 1; fi
if [ "$1" = stop ]; then echo "$kind:stopped-target" >>"$FIXTURE/events"; fi
if [ "$1" = up ]; then
  if [ "${FAIL_TARGET_START:-0}" = 1 ] && [[ "$*" != *'api collab'* ]] && [ "$kind" != "$(cat "$FIXTURE/before.kind")" ]; then exit 1; fi
  case " $* " in
    *' postgres '*) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_postgres-data" ;;
    *' mongo '*) touch "$FIXTURE/volumes/${COMPOSE_PROJECT_NAME}_mongo-data" ;;
  esac
  if [ "${FAIL_HEALTH:-0}" = 1 ] && [ "$kind" != "$(cat "$FIXTURE/before.kind")" ] && [[ "$*" == *'api collab'* ]]; then exit 1; fi
  if [[ "$*" == *'api collab'* ]]; then printf '%s\n' "$kind" >"$FIXTURE/running"; fi
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
  sed -n 's/^GACHIPAD_VERSION=//p' "$FIXTURE/install/.env" >"$FIXTURE/install/VERSION"
  cp -p "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cp -p "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  printf '%s\n' "$2" >"$FIXTURE/running"
  # Keep transaction tests independent of database binaries and network health.
  cat >>"$FIXTURE/install/lib.sh" <<'LIB'
# shellcheck disable=SC2317 # sourced by migration entrypoint
need_docker() { :; }
# shellcheck disable=SC2317
database_backup() { [ "${FAIL_BACKUP:-0}" = 0 ] || return 1; touch "$FIXTURE/backup"; echo backup >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
stop_writes() { if [ "${FAIL_STOP:-0}" = 1 ] && [ "${1:-}" != restore ]; then return 1; fi; touch "$FIXTURE/stopped"; echo stopped >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
database_start() { [ "${FAIL_RECOVERY:-0}" = 0 ] || return 1; echo start >>"$FIXTURE/events"; }
# shellcheck disable=SC2317
wait_api() { :; }
# shellcheck disable=SC2317
wait_healthy() { [ "${FAIL_INGRESS:-0}" = 0 ] || return 1; }
LIB
}
run() { (cd "$FIXTURE/install" && ./migrate-db.sh "$@") >"$FIXTURE/run.log" 2>&1; }
clean_state() {
  [ ! -e "$FIXTURE/install/state/transaction" ]
  [ ! -e "$FIXTURE/install/state/install.lock.d" ]
  [ -z "$(find "$FIXTURE/install" -maxdepth 1 -name '.env.migrate-db.*')" ]
  if grep -q 'private@\|postgresql://\|mongodb://' "$FIXTURE/run.log"; then exit 1; fi
  if [ -f "$FIXTURE/install/state/migrate-db.log" ] &&
    grep -q 'private@\|postgresql://\|mongodb://' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
}
for pair in mongodb:sqlite sqlite:postgres postgres:external; do
  from="${pair%:*}"; to="${pair#*:}"
  make_fixture "success-$from" "$from"
  args=(--to "$to" --yes)
  if [ "$to" = external ]; then export DATABASE_URL='postgresql://fixture:private@target.invalid/db'; fi
  run "${args[@]}"
  unset DATABASE_URL
  [ "$(cat "$FIXTURE/install/state/database-kind")" = "$to" ]
  [ "$(cat "$FIXTURE/running")" = "$to" ]
  case "$to" in
    postgres) grep -qx 'COMPOSE_PROFILES=mdns,postgres' "$FIXTURE/install/.env"; grep -Eq '^POSTGRES_PASSWORD=.+$' "$FIXTURE/install/.env" ;;
    *) grep -qx 'COMPOSE_PROFILES=mdns' "$FIXTURE/install/.env" ;;
  esac
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
  if [ "$status" = 2 ]; then
    grep -q 'destination was not modified: refused' "$FIXTURE/install/state/migrate-db.log"
    if grep -q 'inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
  else grep -q 'destination may hold a partial copy' "$FIXTURE/install/state/migrate-db.log"; fi
  clean_state
  echo "ok: copy exit $status survives npm invocation; old backend runs; new volume removed"
done
make_fixture existing-destination sqlite
touch "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data"
if DEST_NONEMPTY=1 run --to postgres --yes; then exit 1; else [ "$?" = 2 ]; fi
[ ! -e "$FIXTURE/backup" ]
[ ! -e "$FIXTURE/stopped" ]
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
clean_state
echo 'ok: refused existing destination volume is retained'
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
make_fixture replaced-volume sqlite
if COPY_STATUS=1 REPLACE_VOLUME=1 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
grep -q 'identity could not be verified' "$FIXTURE/install/state/migrate-db.log"
[ -e "$FIXTURE/install/state/transaction" ]
echo 'ok: changed volume identity prevents removal during rollback'
make_fixture nothing-written sqlite
if COPY_STATUS=1 COPY_NOT_WRITTEN=1 run --to external --yes; then exit 1; fi
# An external URL must be supplied through the environment, and failure before writes is distinct.
if DATABASE_URL='postgresql://fixture:private@target.invalid/db' COPY_STATUS=1 COPY_NOT_WRITTEN=1 run --to external --yes; then exit 1; fi
grep -q 'destination was not modified; nothing was copied' "$FIXTURE/install/state/migrate-db.log"
if grep -q 'inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
clean_state
make_fixture ingress-opened sqlite
if FAIL_INGRESS=1 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
grep -q 'new backend may have accepted writes; destination retained' "$FIXTURE/install/state/migrate-db.log"
if grep -q 'inspect and clear' "$FIXTURE/install/state/migrate-db.log"; then exit 1; fi
# Recovery health is also failed here, so snapshots must remain.
[ -e "$FIXTURE/install/state/transaction" ]
echo 'ok: ingress-opened failure retains destination writes and snapshots'
make_fixture incomplete sqlite
if COPY_STATUS=1 FAIL_RECOVERY=1 run --to postgres --yes; then exit 1; fi
[ -e "$FIXTURE/install/state/transaction" ]
[ -n "$(find "$FIXTURE/install" -maxdepth 1 -name '.env.migrate-db.*')" ]
grep -q 'cp -p .*original.env .env' "$FIXTURE/install/state/migrate-db.log"
grep -q 'only after recovery succeeds' "$FIXTURE/install/state/migrate-db.log"
[ ! -e "$FIXTURE/install/state/install.lock.d" ]
echo 'ok: incomplete recovery preserves snapshots/transaction and gives concrete commands'
for signal in HUP INT TERM; do
  make_fixture "signal-$signal" sqlite
  # Python avoids the ignored SIGINT disposition of a shell background job. Close both
  # the output reader and stderr, modelling tee/SSH loss while the copy is running.
  COPY_WAIT=1 python3 - "$signal" <<'SIGNAL'
import os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(os.environ["FIXTURE"])
p = subprocess.Popen(["./migrate-db.sh", "--to", "postgres", "--yes"],
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
    (root / "release-copy").touch()
    assert p.wait(timeout=20) == 128 + sig
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
SIGNAL
  cmp "$FIXTURE/install/.env" "$FIXTURE/before.env"
  cmp "$FIXTURE/install/state/database-kind" "$FIXTURE/before.kind"
  [ "$(cat "$FIXTURE/running")" = sqlite ]
  [ ! -e "$FIXTURE/volumes/gp-dbdeploy-fixture_postgres-data" ]
  : >"$FIXTURE/run.log"
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
echo 'migrate-db.test.sh: all checks passed'
