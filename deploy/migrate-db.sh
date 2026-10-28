#!/usr/bin/env bash
# Offline database copy; source data and its volume are retained after the switch.
set -euo pipefail
umask 077
# Recovery must not depend on a terminal, pipe reader or an SSH connection.
trap '' PIPE
cd "$(dirname "$0")"
. ./lib.sh
declare -F assert_no_database_migration >/dev/null || die 'lib.sh is older than this script'

TO=""
TARGET_URL="${DATABASE_URL:-}"
YES=0
WINDOW="${GACHIPAD_COPY_WINDOW_MINUTES:-15}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --to) TO="${2:?--to needs sqlite, postgres, mongodb or external}"; shift ;;
    --window-minutes) WINDOW="${2:?--window-minutes needs an integer}"; shift ;;
    --yes) YES=1 ;;
    -h | --help)
      cat <<'HELP'
usage: ./migrate-db.sh --to sqlite|postgres|mongodb|external [--window-minutes N] [--yes]
External destination: use the hidden terminal prompt, or read -rs DATABASE_URL; export DATABASE_URL.
Unset DATABASE_URL before choosing a bundled destination.
External source: set GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1 after a server backup.
Window: integer 15..1440, default GACHIPAD_COPY_WINDOW_MINUTES or 15 minutes.
Diagnostics and records expiring within the window (and their child records) are skipped.
The copy must finish within window minus 5 minutes. Raise the window for larger databases:
measured uploads: about 40 MB/s into PostgreSQL, 85-106 MB/s into SQLite;
Minimum window in minutes: size in MB / throughput in MB/s / 60 * 2 + 5.
Allow more for your network, disk and record count; the minimum supported window is 15.
Source data and backups are retained. Migration back requires an empty destination.
Recovery details and command output: state/migrate-db.log (private).
HELP
      exit 0 ;;
    *) die 'unknown option (./migrate-db.sh --help)' ;;
  esac
  shift
done
if ! [[ "$WINDOW" =~ ^[0-9]{1,4}$ ]] || [ "$((10#$WINDOW))" -lt 15 ] || [ "$((10#$WINDOW))" -gt 1440 ]; then
  die '--window-minutes must be a whole number from 15 to 1440'
fi
WINDOW="$((10#$WINDOW))"
case "$TO" in sqlite | postgres | mongodb | external) ;; *) die '--to must be sqlite, postgres, mongodb or external' ;; esac
if [ "$TO" = external ]; then
  if [ -z "$TARGET_URL" ] && [ -t 0 ]; then
    read -r -s -p 'Destination DATABASE_URL (hidden): ' TARGET_URL
    echo
  fi
  [ -n "$TARGET_URL" ] || die '--to external requires exported DATABASE_URL or a hidden terminal prompt'
  validate_database_url "$TARGET_URL" || die 'DATABASE_URL has an unsupported scheme'
  [[ "$TARGET_URL" == *://?* ]] || die 'DATABASE_URL requires a server scheme followed by :// and a host'
  [[ "$TARGET_URL" != sqlite:* ]] || die '--to external requires a server database URL'
else
  [ -z "$TARGET_URL" ] || die 'DATABASE_URL is only accepted with --to external'
fi
# The source is always the saved installation, never an exported target selection.
unset DATABASE_URL GACHIPAD_DB COMPOSE_PROFILES GACHIPAD_DATABASE_URL
need_docker
[ -f .env ] || die '.env is missing; run this from the installed bundle'
STAGE=""
CONFIG_SNAPSHOT_READY=0
STOPPED=0
COPY_STARTED=0
SUCCESS=0
NEW_VOLUME=0
TARGET_VOLUME=""
VOLUME_ID=""
RUN_ID="$(openssl rand -hex 16)"
ACTIVE_CONTAINER=""
ACTIVE_PID=""
SOURCE=""
TARGET_STARTED=0
INGRESS_OPENED=0
COPY_REFUSED=0
COPY_REFUSAL_SIDE=destination
COPY_UNWRITTEN=0
LOG=state/migrate-db.log

migration_message() {
  echo "$*" || true
  echo "$*" >&3 || true
}

# wait is interruptible even when the Compose client/container ignores a signal.
migration_run() {
  "$@" <&0 &
  ACTIVE_PID=$!
  local status=0
  wait "$ACTIVE_PID" || status=$?
  ACTIVE_PID=""
  return "$status"
}

migration_logged_run() {
  local log="$1" status=0
  shift
  (set -o pipefail; "$@" | tee -p "$log") <&0 &
  ACTIVE_PID=$!
  wait "$ACTIVE_PID" || status=$?
  ACTIVE_PID=""
  return "$status"
}

# Publish the next phase before its first side effect. An interrupted write leaves the
# previous (conservative) phase intact and a named temporary file for manual cleanup.
migration_phase() {
  printf 'database migration\nsnapshot=%s\nphase=%s\nsource=%s\ndestination=%s\nvolume=%s\nrun=%s\n' \
    "$STAGE" "$1" "$SOURCE" "$TO" "$TARGET_VOLUME" "$RUN_ID" >state/transaction.tmp
  sync state/transaction.tmp 2>/dev/null || sync
  mv state/transaction.tmp state/transaction
}

migration_cleanup() {
  trap '' HUP INT TERM PIPE
  local status="$1" recovered=1 service identity remaining
  set +e
  trap - EXIT
  # Redirect before any recovery command; even a dead tee cannot interrupt recovery.
  shopt -s execfail
  exec >>"$LOG" 2>&1 || exec >/dev/null 2>&1
  # Remove the one-off before restoring configuration or restarting any source writers.
  if [ -n "$ACTIVE_CONTAINER" ]; then
    docker rm -f "$ACTIVE_CONTAINER" >/dev/null 2>&1 || {
      remaining="$(docker container ls -aq --filter "name=^/${ACTIVE_CONTAINER}$")" || recovered=0
      [ -z "$remaining" ] || recovered=0
    }
    [ "$recovered" != 1 ] || migration_message 'migrate-db: migration container stopped and removed before recovery.'
  fi
  [ -z "$ACTIVE_PID" ] || kill "$ACTIVE_PID" 2>/dev/null || true
  if [ "$SUCCESS" = 0 ] && [ -n "$STAGE" ]; then
    if [ "$recovered" != 1 ]; then
      migration_message 'migrate-db: could not confirm migration container removal; writers stay stopped.'
    elif [ "$STOPPED" = 1 ]; then
      stop_writes restore >&2 || recovered=0
    fi
    case "$TO" in
      postgres) service=postgres ;;
      mongodb) service=mongo ;;
      *) service="" ;;
    esac
    if [ -n "$service" ] && [ "$TO" != "$SOURCE" ] && [ "$TARGET_STARTED" = 1 ]; then
      docker compose --env-file "$STAGE/.env" stop "$service" >&2 || recovered=0
      if [ "$INGRESS_OPENED" = 0 ]; then
        if [ "$TO" = mongodb ]; then
          docker compose --env-file "$STAGE/.env" rm -sfv mongo-users mongo >&2 || recovered=0
        else docker compose --env-file "$STAGE/.env" rm -sf "$service" >&2 || recovered=0; fi
      fi
    fi
    if [ "$CONFIG_SNAPSHOT_READY" = 1 ]; then
      cp -p "$STAGE/original.env" .env.migrate-recovery && mv .env.migrate-recovery .env || recovered=0
      if [ -f "$STAGE/original.kind" ]; then
        cp -p "$STAGE/original.kind" state/database-kind.tmp && mv state/database-kind.tmp state/database-kind || recovered=0
      else rm -f state/database-kind || recovered=0; fi
    fi
    if [ "$STOPPED" = 1 ] && [ "$recovered" = 1 ]; then
      database_start 120 && docker compose up -d --pull never --wait --wait-timeout 120 api collab &&
        wait_api 120 && docker compose up -d --pull never && wait_healthy 120 || recovered=0
    fi
    if [ "$NEW_VOLUME" = 1 ] && [ "$INGRESS_OPENED" = 0 ] && [ "$recovered" = 1 ]; then
      identity="$(docker volume inspect --format '{{.CreatedAt}} {{index .Labels "gachipad.migration"}}' "$TARGET_VOLUME")" || identity=""
      if [ -n "$VOLUME_ID" ] && [ "$identity" = "$VOLUME_ID $RUN_ID" ]; then
        docker volume rm "$TARGET_VOLUME" >/dev/null || {
          migration_message 'migrate-db: could not remove the newly created destination volume; inspect it before retrying.'
          recovered=0
        }
      else
        migration_message 'migrate-db: destination volume identity could not be verified; retained for manual inspection.'
        recovered=0
      fi
    fi
    if [ "$COPY_REFUSED" = 1 ]; then
      case "$COPY_REFUSAL_SIDE" in
        source) migration_message 'migrate-db: source refused (see the Result line above); nothing was copied. Fix the source and retry; do not delete -wal/-shm files, which can hold committed data.' ;;
        destination) migration_message 'migrate-db: destination was not modified: refused (see the Result line above); use an empty destination.' ;;
        *) migration_message 'migrate-db: copy refused before writing (see the Result line above); nothing was copied. Fix the cause and retry.' ;;
      esac
    elif [ "$COPY_UNWRITTEN" = 1 ]; then
      migration_message 'migrate-db: destination was not modified; nothing was copied. Fix the cause and retry.'
    elif [ "$COPY_STARTED" = 1 ] && [ "$INGRESS_OPENED" = 0 ]; then
      migration_message 'migrate-db: destination may hold a partial copy; inspect and clear it before retrying. Existing destination volumes are kept.'
    fi
    if [ "$COPY_REFUSED" = 0 ] && [ "$COPY_UNWRITTEN" = 0 ] && [ "$INGRESS_OPENED" = 0 ] &&
      { [ "$COPY_STARTED" = 1 ] || [ "$STOPPED" = 1 ] || [ "$TARGET_STARTED" = 1 ]; }; then
      case "$TO" in
        sqlite) migration_message 'migrate-db: if retained, SQLite destination files are /data/gachipad.db, /data/gachipad.db-wal and /data/gachipad.db-shm in the shared gachipad-data volume; inspect them with writers stopped before removing only those destination files.' ;;
        postgres | mongodb) migration_message "migrate-db: if retained, inspect destination volume $TARGET_VOLUME before retrying; an offline target start may have initialized a previously empty volume. Never remove a pre-existing volume without checking its data." ;;
        external) migration_message 'migrate-db: inspect the external destination with its server tools; clear it only if the Result line says to drop the destination.' ;;
      esac
    fi
    if [ "$INGRESS_OPENED" = 1 ]; then
      migration_message 'migrate-db: new backend may have accepted writes; destination retained. Reconcile those writes before retrying or removing any data.'
    fi
    if [ "$recovered" = 1 ]; then
      migration_message 'migrate-db: migration failed; previous configuration restored and old backend retained.'
    else
      migration_message "migrate-db: automatic recovery incomplete; configuration snapshots kept in $STAGE."
      status=3
      migration_recovery_hint "$STAGE" | while IFS= read -r line; do migration_message "$line"; done
    fi
  fi
  if [ -n "$STAGE" ] && [ "$recovered" = 1 ]; then
    rm -rf "$STAGE"
    rm -f .env.migrate-next .env.migrate-recovery state/database-kind.tmp state/transaction.tmp state/transaction
  fi
  install_unlock || true
  exit "$status"
}
trap 'migration_cleanup "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for tool in curl tee gzip tar openssl df awk sed mktemp cp mv chmod rm cat grep head tail dirname timeout sync; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"
done
tee -p </dev/null >/dev/null 2>&1 || die 'tee with -p support is required for migration logging'
install_lock
# GNU tee keeps recording after a pipe/terminal reader disappears; recovery also redirects
# directly to this file. The logger inherits ignored signals and PIPE.
chmod 600 "$LOG" 2>/dev/null || true
exec 3>&1
exec > >(trap '' HUP INT TERM PIPE; exec 9>&-; exec tee -i -p -a "$LOG") 2>&1
if [ ! -f VERSION ] || [ "$(cat VERSION)" != "$(env_get GACHIPAD_VERSION)" ]; then
  die 'VERSION must match the installed GACHIPAD_VERSION; extract scripts from the same verified release'
fi

SOURCE="$(database_kind)"
SOURCE_URL="$(env_get DATABASE_URL "$(env_get GACHIPAD_DATABASE_URL)")"
[ -n "$SOURCE_URL" ] || die 'source database URL is missing; run ./generate-secrets.sh first'

if [ -e state/transaction ] || [ -L state/transaction ]; then
  if grep -qx 'database migration' state/transaction 2>/dev/null; then migration_recovery_hint ""
  else echo 'migrate-db: inspect the unfinished transaction and recover manually per OPERATIONS 15.7; preserve rollback and backups.'; fi
  die 'unfinished transaction exists; recover it before migrating'
fi
assert_no_database_migration
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
  read -r -p "Copy $SOURCE to $TO with writers stopped? Diagnostics and records expiring within $WINDOW minutes are skipped; deadline $((WINDOW - 5)) minutes. [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die 'cancelled'
fi

# Generate the target profile and secrets in a private staging directory. Live .env stays intact.
STAGE="$(mktemp -d .env.migrate-db.XXXXXX)"
# Record the destination identity and phase before copying the private configuration.
if [ "$TO" != external ]; then TARGET_VOLUME="$(database_project)_$(database_volume_suffix "$TO")"; fi
migration_phase preflight
cp -p .env "$STAGE/original.env"
[ ! -f state/database-kind ] || cp -p state/database-kind "$STAGE/original.kind"
CONFIG_SNAPSHOT_READY=1
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
# A successful list distinguishes absence from an inspect/daemon error. A unique label
# plus creation identity is required before cleanup may remove any volume.
if [ "$TO" != external ]; then
  volumes="$(docker volume ls -q)" || die 'cannot list destination volumes; refusing migration'
  if grep -qxF "$TARGET_VOLUME" <<<"$volumes"; then
    docker volume inspect "$TARGET_VOLUME" >/dev/null || die 'cannot inspect destination volume; refusing migration'
    if database_volume_nonempty "$TARGET_VOLUME" "$TO"; then
      COPY_REFUSED=1
      echo 'Result: refused (Destination is not empty).'
      exit 2
    fi
  else
    docker volume create --label "gachipad.migration=$RUN_ID" \
      --label "com.docker.compose.project=$(database_project)" \
      --label "com.docker.compose.volume=$(database_volume_suffix "$TO")" "$TARGET_VOLUME" >/dev/null
    identity="$(docker volume inspect --format '{{.CreatedAt}} {{index .Labels "gachipad.migration"}}' "$TARGET_VOLUME")" ||
      die 'cannot verify created destination volume; retained for manual inspection'
    [ "${identity#* }" = "$RUN_ID" ] || die 'destination volume appeared concurrently; retained for manual inspection'
    VOLUME_ID="${identity%% *}"
    NEW_VOLUME=1
  fi
fi
# Check the image, source, external destination and space before downtime.
# Bundled destinations use the read-only volume probe; their server starts only offline.
ACTIVE_CONTAINER="gachipad-migrate-$RUN_ID-image"
GACHIPAD_EXPECT_VERSION="$(cat VERSION)" migration_run docker compose --env-file "$STAGE/.env" run --rm --name "$ACTIVE_CONTAINER" --no-deps --pull never -T \
  -e GACHIPAD_EXPECT_VERSION api node -e '
    const fs = require("node:fs"); const p = require("./package.json");
    if (!p.scripts?.["copy-db"] || !fs.existsSync("src/copy-db.ts") ||
        fs.readFileSync("VERSION", "utf8").trim() !== process.env.GACHIPAD_EXPECT_VERSION) process.exit(1);
  ' || die 'installed API image/version lacks the matching copy CLI; use the same verified release'
ACTIVE_CONTAINER="gachipad-migrate-$RUN_ID-preflight"
preflight_status=0
GACHIPAD_COPY_FROM="$SOURCE_URL" GACHIPAD_COPY_TO="$TARGET_CONNECTION" GACHIPAD_COPY_WINDOW_MINUTES="$WINDOW" GACHIPAD_PREFLIGHT_BUNDLED="$TO" \
  migration_logged_run "$STAGE/preflight.log" docker compose --env-file "$STAGE/.env" run --rm --name "$ACTIVE_CONTAINER" --no-deps --pull never -T \
    -e GACHIPAD_COPY_FROM -e GACHIPAD_COPY_TO -e GACHIPAD_PREFLIGHT_BUNDLED api node --import /opt/tsx/node_modules/tsx/dist/esm/index.mjs --input-type=module - <<'PREFLIGHT' || preflight_status=$?
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, statfsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
// Keep the watchdog alive through imports, opens, queries and closes. Never log driver messages.
const watchdog = setTimeout(() => { console.error("migrate-db: preflight failed (ETIMEDOUT); nothing was copied."); process.exit(1); }, 120000);
let status = 0;
let phase = "IMPORT";
let sqlErrorCode = () => undefined;
try {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@gachipad/storage"));
  const driverModule = await import(pathToFileURL(join(root, "sql/driver.ts")).href);
  const { createSqlTransferBackend, supportedSqlSchema } = await import(pathToFileURL(join(root, "transfer/sql.ts")).href);
  const { createMongoTransferBackend } = await import(pathToFileURL(join(root, "transfer/mongo.ts")).href);
  const { MongoClient } = await import("mongodb");
  const { openSqlDriver } = driverModule;
  sqlErrorCode = driverModule.sqlErrorCode;
  const sqlitePath = url => url.startsWith("sqlite://") ? decodeURIComponent(new URL(url).pathname) : url.slice(7);
  let bytes = 0n;
  const source = process.env.GACHIPAD_COPY_FROM;
  const target = process.env.GACHIPAD_COPY_TO;
  phase = "SOURCE";
  if (source.startsWith("sqlite:")) {
    const path = sqlitePath(source);
    if (/^file:/i.test(path) || path === ":memory:") throw new Error();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const driver = { dialect: "sqlite", all: async (sql, values = []) => db.prepare(sql).all(...values) };
      if (!await supportedSqlSchema(driver)) throw Object.assign(new Error(), { code: "SOURCE_SCHEMA" });
      bytes = BigInt(statSync(path).size);
      if (existsSync(`${path}-wal`)) bytes += BigInt(statSync(`${path}-wal`).size);
    } finally { db.close(); }
  } else if (/^mongodb(?:\+srv)?:/.test(source)) {
    const client = new MongoClient(source, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 30000 });
    try { await client.connect(); bytes = BigInt(Math.ceil((await client.db().command({ dbStats: 1 })).dataSize)); }
    finally { await client.close(); }
  } else {
    const driver = await openSqlDriver(source);
    try {
      if (!await supportedSqlSchema(driver)) throw Object.assign(new Error(), { code: "SOURCE_SCHEMA" });
      const rows = await driver.all(driver.dialect === "postgres"
        ? "SELECT pg_database_size(current_database()) AS bytes"
        : "SELECT COALESCE(SUM(data_length+index_length),0) AS bytes FROM information_schema.tables WHERE table_schema=DATABASE()");
      bytes = BigInt(rows[0].bytes);
    } finally { await driver.close(); }
  }
  phase = "DATA_SPACE";
  const space = statfsSync(process.env.GACHIPAD_PREFLIGHT_DATA_PATH || "/data", { bigint: true });
  const required = bytes + (bytes / 5n > 67108864n ? bytes / 5n : 67108864n);
  console.log(`migrate-db: required local disk space: ${required} bytes`);
  const rate = target.startsWith("sqlite:") ? 85 : 40;
  console.log(`migrate-db: estimated minimum copy window: ${Math.max(15, Math.ceil(Number(bytes) / 1000000 / rate / 60 * 2 + 5))} minutes; allow more for network and record count.`);
  if (space.bavail * space.bsize < required) throw new Error();
  phase = "DESTINATION";
  // Bundled destinations are checked read-only by the shell. Never initialize a DB in preflight.
  if (process.env.GACHIPAD_PREFLIGHT_BUNDLED !== "external") {
    console.log("migrate-db: bundled destination checked without starting its database.");
  } else if (target.startsWith("sqlite:")) {
    throw new Error();
  } else if (/^mongodb(?:\+srv)?:/.test(target)) {
    const client = new MongoClient(target, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 30000 });
    try {
      await client.connect();
      if (!await createMongoTransferBackend(client.db()).isEmpty()) status = 2;
    } finally { await client.close(); }
  } else {
    const driver = await openSqlDriver(target);
    try {
      if (!await createSqlTransferBackend(driver).isEmpty()) status = 2;
    } finally { await driver.close(); }
  }
  console.log(status === 2 ? "Result: refused (Destination is not empty)."
    : "migrate-db: preflight passed (image, destination and local data space).");
} catch (error) {
  const code = sqlErrorCode(error) || (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 99999 ? `MONGO_${error.code}` : phase);
  console.error(`migrate-db: preflight failed (${code}); nothing was copied.`);
  status = 1;
}
// A driver may leave live handles even after a resolved/rejected close. Always exit explicitly.
clearTimeout(watchdog);
process.exit(status);
PREFLIGHT
if [ "$preflight_status" != 0 ]; then
  if [ "$preflight_status" = 2 ] && grep -q '^Result: refused' "$STAGE/preflight.log"; then COPY_REFUSED=1; fi
  exit "$preflight_status"
fi
ACTIVE_CONTAINER=""
required="$(sed -n 's/^migrate-db: required local disk space: \([0-9][0-9]*\) bytes$/\1/p' "$STAGE/preflight.log")"
[[ "$required" =~ ^[0-9]+$ ]] || die 'preflight did not report disk-space requirement'
mkdir -p backups
df -Pk backups | awk -v required="$required" 'NR == 2 {exit !($4 * 1024 >= required)}' ||
  die 'backup filesystem needs source size plus 20 percent (at least 64 MiB extra)'
if [ -n "$TARGET_VOLUME" ]; then
  GACHIPAD_REQUIRED_BYTES="$required" docker run --rm --pull never --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges -v "$TARGET_VOLUME:/probe:ro" \
    -e GACHIPAD_REQUIRED_BYTES --entrypoint node \
    "$(env_get GACHIPAD_REGISTRY ghcr.io/kim0040)/gachipad-api:$(cat VERSION)" -e '
      const s = require("node:fs").statfsSync("/probe", { bigint: true });
      if (s.bavail * s.bsize < BigInt(process.env.GACHIPAD_REQUIRED_BYTES)) process.exit(1);
    ' || die 'destination filesystem needs source size plus 20 percent (at least 64 MiB extra)'
fi
migration_phase backup
STOPPED=1
stop_writes || die 'writers did not stop cleanly; migration cancelled'
# A killed last writer can leave WAL sidecars; fold them into the stopped source first.
if [ "$SOURCE" = sqlite ]; then
  ACTIVE_CONTAINER="gachipad-migrate-$RUN_ID-checkpoint"
  GACHIPAD_COPY_FROM="$SOURCE_URL" migration_run timeout --foreground --kill-after=5s 180s docker compose run --rm --name "$ACTIVE_CONTAINER" --no-deps --pull never -T \
    -e GACHIPAD_COPY_FROM api node --input-type=module - <<'CHECKPOINT' || die 'SQLite source checkpoint failed, timed out or -wal/-shm files remain; stop other SQLite users and inspect the source; do not delete -wal/-shm files, which can hold committed data'
import { existsSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
try {
  const url = process.env.GACHIPAD_COPY_FROM;
  const path = url.startsWith("sqlite://") ? decodeURIComponent(new URL(url).pathname) : url.slice(7);
  if (/^file:/i.test(path) || path === ":memory:" || !existsSync(path)) throw new Error();
  const paths = new Set([path, realpathSync(path)]);
  const sidecars = () => [...paths].some(p => existsSync(`${p}-wal`) || existsSync(`${p}-shm`));
  if (sidecars()) {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=3000");
      const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (result.busy !== 0) throw Object.assign(new Error(), { code: "SQLITE_BUSY" });
    } finally { db.close(); }
    if (sidecars()) throw new Error();
    console.log("migrate-db: stopped SQLite source checkpointed; WAL sidecars removed.");
  }
} catch (error) {
  const code = error?.code ?? error?.errcode;
  const safe = typeof code === "number" || /^[A-Z][A-Z0-9_]{0,63}$/.test(code ?? "") ? code : "CHECKPOINT_FAILED";
  console.error(`migrate-db: SQLite checkpoint refused (${safe}); source missing, busy or WAL sidecars remain. Do not delete -wal/-shm files; they can hold committed data.`);
  process.exit(1);
}
CHECKPOINT
fi
ACTIVE_CONTAINER=""
TARGET_STARTED=1
case "$TO" in
  postgres) migration_run docker compose --env-file "$STAGE/.env" up -d --pull never --wait --wait-timeout 120 postgres ;;
  mongodb)
    migration_run docker compose --env-file "$STAGE/.env" up -d --pull never --wait --wait-timeout 120 mongo
    ACTIVE_CONTAINER="gachipad-migrate-$RUN_ID-users"
    migration_run docker compose --env-file "$STAGE/.env" run --rm --name "$ACTIVE_CONTAINER" --no-deps --pull never -T mongo-users ;;
esac
echo "migrate-db: backing up quiescent $SOURCE before copying to $TO."
database_backup ./backups || die 'source backup failed; migration cancelled'

migration_phase copy
echo "migrate-db: copying offline; records expiring within $WINDOW minutes are skipped; deadline $((WINDOW - 5)) minutes."
ACTIVE_CONTAINER="gachipad-migrate-$RUN_ID-copy"
COPY_STARTED=1
copy_status=0
GACHIPAD_COPY_FROM="$SOURCE_URL" GACHIPAD_COPY_TO="$TARGET_CONNECTION" GACHIPAD_COPY_WINDOW_MINUTES="$WINDOW" \
  migration_logged_run "$STAGE/copy.log" docker compose --env-file "$STAGE/.env" run --rm --name "$ACTIVE_CONTAINER" --no-deps --pull never -T \
    -e GACHIPAD_COPY_FROM -e GACHIPAD_COPY_TO -e GACHIPAD_COPY_WINDOW_MINUTES -e NPM_CONFIG_UPDATE_NOTIFIER=false api npm run --silent copy-db || copy_status=$?
if grep -q '^Result: failed.*; nothing was copied\.$' "$STAGE/copy.log"; then COPY_UNWRITTEN=1; fi
if [ "$copy_status" = 2 ] && grep -q '^Result: refused' "$STAGE/copy.log"; then
  COPY_STARTED=0
  COPY_REFUSED=1
  if grep -q '^Result: refused (Destination is not empty)' "$STAGE/copy.log"; then COPY_REFUSAL_SIDE=destination
  elif grep -Ei '^Result: refused .*source|^Result: refused \(Audit details' "$STAGE/copy.log" >/dev/null; then COPY_REFUSAL_SIDE=source
  else COPY_REFUSAL_SIDE=copy; fi
fi
if [ "$copy_status" != 0 ]; then
  echo "migrate-db: copy exited $copy_status; configuration will be restored." >&2
  exit "$copy_status"
fi

ACTIVE_CONTAINER=""
migration_phase switch
# Publish the target env atomically and marker under the same install lock; EXIT restores both.
cp -p "$STAGE/.env" .env.migrate-next
mv .env.migrate-next .env
record_database_backend
database_start 120
docker compose up -d --pull never --wait --wait-timeout 120 api collab
wait_api 120
migration_phase live
INGRESS_OPENED=1
docker compose up -d --pull never
wait_healthy 120
SUCCESS=1
case "$SOURCE" in
  mongodb) docker compose --profile mongodb stop mongo || true ;;
  postgres) docker compose --profile postgres stop postgres || true ;;
esac
echo "migrate-db: success ($SOURCE -> $TO); previous backend data and backups are kept."
if [ "$SOURCE" = external ]; then
  echo 'migrate-db: after checking shares and uploads, remove the old external database manually with its server tools.'
else
  OLD_VOLUME="$(database_project)_$(database_volume_suffix "$SOURCE")"
  case "$SOURCE" in
    mongodb) echo 'migrate-db: after checking shares and uploads, run: docker compose --profile mongodb rm -sfv mongo-users mongo' ;;
    postgres) echo 'migrate-db: after checking shares and uploads, run: docker compose --profile postgres rm -sf postgres' ;;
    sqlite) echo 'migrate-db: after checking shares and uploads, stop ingress and release the data mount first: docker compose stop caddy api collab && docker compose rm -f api collab' ;;
  esac
  echo "migrate-db: migration back requires an empty destination. After checking shares/uploads, remove the old data manually: docker volume rm $OLD_VOLUME"
  [ "$SOURCE" != sqlite ] || echo 'migrate-db: then restart the application: docker compose up -d --pull never'
fi
