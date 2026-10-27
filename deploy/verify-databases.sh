#!/usr/bin/env bash
# Real database-choice checks, invoked by verify-update.sh --rename with two built bundles.
# Resources belong to the caller's gp-dbdeploy-* project; no shared server is modified except
# the explicitly owned temporary PostgreSQL database, which is dropped on exit.
set -euo pipefail
BASE="$(realpath "${1:?baseline bundle}")"
NEXT="$(realpath "${2:?next bundle}")"
WORK="${3:?owned verification directory}"
PROJECT="${4:?owned compose project}"
P="${VERIFY_DATABASE_HTTP_PORT:-18081}"
TLS_P="${VERIFY_DATABASE_HTTPS_PORT:-18444}"
INSTALL="$WORK/selection"
DB="$PROJECT-external"
RELAY="$PROJECT-pg-relay"
RELAY_STARTED=0
DB_CREATED=0
case "$PROJECT" in gp-dbdeploy-*) ;; *) echo 'verification requires a gp-dbdeploy- project' >&2; exit 1 ;; esac
in_install() { (cd "$INSTALL" && COMPOSE_PROJECT_NAME="$PROJECT" "$@"); }
cleanup_stack() {
  local registry image
  if [ -f "$INSTALL/docker-compose.yml" ]; then
    in_install docker compose --profile mongodb --profile postgres down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker network rm "${PROJECT}_default" >/dev/null 2>&1 || true
  registry="$(sed -n 's/^GACHIPAD_REGISTRY=//p' "$INSTALL/.env.example" 2>/dev/null | tail -n1 || true)"
  # The next case reloads its bundle. Keep shared/base images and release registries intact.
  case "$registry" in localhost:*/*gp-dbdeploy-*)
    while IFS= read -r image; do
      docker image rm -f "$image" >/dev/null 2>&1 || true
    done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | awk -v prefix="$registry/gachipad-" 'index($0, prefix) == 1')
    ;;
  esac
  rm -rf "$INSTALL"
}
cleanup() {
  local status=$?
  trap - EXIT
  if [ "$RELAY_STARTED" = 1 ]; then docker rm -f "$RELAY" >/dev/null; fi
  cleanup_stack
  if [ "$DB_CREATED" = 1 ]; then docker exec gp-sql-pg dropdb -U gp --if-exists --force "$DB"; fi
  exit "$status"
}
trap cleanup EXIT
fail() { echo "FAIL: database selection: $*" >&2; exit 1; }
call() {
  local path="$1"; shift
  curl -fsS --max-time 30 -b "$WORK/selection.jar" -c "$WORK/selection.jar" -H 'X-Gachipad: 1' "$@" "http://127.0.0.1:$P$path"
}
check_share() {
  call "/api/shares/$ID/download" -o "$WORK/selection.zip"
  unzip -p "$WORK/selection.zip" | grep -q 'database selection fixture' || fail 'share content missing'
}
prepare() {
  mkdir -p "$INSTALL"
  tar xzf "$BASE" -C "$INSTALL" --strip-components=1
  cp "$INSTALL/.env.example" "$INSTALL/.env"
  # shellcheck disable=SC2016 # expanded by the installation shell
  in_install bash -c '. ./lib.sh; env_set HTTP_PORT "$1"; env_set HTTPS_PORT "$2"; env_set NETWORK_SUBNET 172.29.98.0/24; env_set UPDATE_CHECK off; env_set MONGO_CACHE_GB 0.25; env_set VALKEY_MAXMEMORY 128mb' _ "$P" "$TLS_P"
  rm -f "$WORK/selection.jar"
}
seed() {
  ID="$(call /api/shares -H 'Content-Type: application/json' -d '{"title":"Database fixture","files":[{"path":"main.txt","content":"database selection fixture"}]}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  check_share
}
# Use real release images, but make only the candidate API fail its health check.
BAD="$WORK/selection-unhealthy.tar.gz"
mkdir -p "$WORK/selection-unhealthy"
tar xzf "$NEXT" -C "$WORK/selection-unhealthy" --strip-components=1
sed -i '/^  api:$/a\    command: ["node", "-e", "process.exit(1)"]' "$WORK/selection-unhealthy/docker-compose.yml"
(
  cd "$WORK/selection-unhealthy"
  # shellcheck disable=SC2094 # manifest excluded from its own input
  find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS
)
tar czf "$BAD" -C "$WORK" selection-unhealthy
sha256sum "$BAD" >"$BAD.sha256"
for choice in sqlite postgres; do
  echo "selection: real $choice install, API share, online backup, delete, restore and offline update"
  prepare
  if [ "$choice" = sqlite ]; then
    cp "$INSTALL/.env" "$WORK/literal-original.env"
    # shellcheck disable=SC2016 # expanded by the installation shell
    EXPECTED_URL="postgresql://fixture:literal\$TOKEN#password@db.invalid/it's-literal" in_install bash -c '
      . ./lib.sh
      env_set DATABASE_URL "$EXPECTED_URL"
      ./generate-secrets.sh >/dev/null
      expected="$(printf '\''%s'\'' "$EXPECTED_URL" | sha256sum | cut -d '\'' '\'' -f1)"
      for service in api collab; do
        docker compose run --rm --no-deps -T --pull never --entrypoint node "$service" -e '\''
          const actual = require("node:crypto").createHash("sha256").update(process.env.DATABASE_URL).digest("hex");
          if (actual !== process.argv[1]) throw new Error("Compose changed the literal database URL");
        '\'' "$expected"
      done
    '
    cp "$WORK/literal-original.env" "$INSTALL/.env"
    echo 'PASS: Compose preserves literal URL password and path characters for both applications'
  fi
  if [ "$choice" = sqlite ]; then in_install ./install.sh; else in_install ./install.sh --db postgres; fi
  [ "$(cat "$INSTALL/state/database-kind")" = "$choice" ] || fail 'wrong backend marker'
  services="$(in_install docker compose ps --services)"
  grep -qx valkey <<<"$services" || fail 'Valkey is missing'
  ! grep -qx mongo <<<"$services" || fail 'unselected MongoDB started'
  if [ "$choice" = sqlite ]; then ! grep -qx postgres <<<"$services" || fail 'unselected PostgreSQL started'; fi
  seed
  if [ "$choice" = postgres ]; then
    # shellcheck disable=SC2016 # expanded only in the database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE gp_deploy_fixture (data text); INSERT INTO gp_deploy_fixture SELECT md5(random()::text) FROM generate_series(1, 10000)"
    ' >/dev/null
  else
    gzip -c </dev/null >"$WORK/empty-sqlite.gz"
    if in_install ./restore.sh "$WORK/empty-sqlite.gz" --yes >"$WORK/empty-sqlite.log" 2>&1; then fail 'empty SQLite backup accepted'; fi
    check_share
  fi
  in_install ./backup.sh "$WORK/selection-backups-$choice" >"$WORK/selection-backup.log"
  cat "$WORK/selection-backup.log"
  backup="$(sed -n 's/^backup: \(.*\) (.*/\1/p' "$WORK/selection-backup.log")"
  gzip -t "$backup"
  if [ "$choice" = postgres ]; then
    [ "$(wc -c <"$backup")" -gt 65536 ] || fail 'PostgreSQL archive did not exercise full-stream validation'
    # shellcheck disable=SC2016 # expanded only in the database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE TABLE gp_deploy_after_backup (data text)"
    ' >/dev/null
  fi
  check_share
  call "/api/shares/$ID" -X DELETE >/dev/null
  [ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -b "$WORK/selection.jar" "http://127.0.0.1:$P/api/shares/$ID")" = 404 ] || fail 'share was not deleted'
  in_install ./restore.sh "$backup" --yes
  check_share
  if [ "$choice" = postgres ]; then
    # shellcheck disable=SC2016 # expanded only in the database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT to_regclass('\''gp_deploy_after_backup'\'') IS NULL AND (SELECT count(*) FROM gp_deploy_fixture) = 10000"
    ' | grep -qx t || fail 'PostgreSQL restore did not replace the complete database'
  fi
  if [ "$choice" = postgres ]; then
    in_install docker compose exec -T api node -e 'require("node:fs").writeFileSync("/data/cache-fixture", "unrelated cache")'
    # A valid archive whose policy names an absent role passes TOC validation but fails restore.
    # shellcheck disable=SC2016 # expanded only inside the owned database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE ROLE gp_deploy_restore_missing; CREATE POLICY gp_deploy_restore_policy ON gp_deploy_fixture TO gp_deploy_restore_missing USING (true)"
    ' >/dev/null
    in_install ./backup.sh "$WORK/selection-failed-restore" >"$WORK/selection-failed-restore-backup.log"
    failed_backup="$(sed -n 's/^backup: \(.*\) (.*/\1/p' "$WORK/selection-failed-restore-backup.log")"
    # shellcheck disable=SC2016 # expanded only inside the owned database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP POLICY gp_deploy_restore_policy ON gp_deploy_fixture; DROP ROLE gp_deploy_restore_missing"
    ' >/dev/null
    if in_install ./restore.sh "$failed_backup" --yes >"$WORK/selection-failed-restore.log" 2>&1; then fail 'invalid PostgreSQL restore succeeded'; fi
    grep -q 'PostgreSQL restore failed; live database unchanged; safety backup:' "$WORK/selection-failed-restore.log" || fail 'PostgreSQL safety archive guidance missing'
    grep -q 'gp_deploy_restore_missing.*does not exist' "$WORK/selection-failed-restore.log" || fail 'restore failure was not injected'
    in_install docker compose up -d --wait >/dev/null
    check_share
    # shellcheck disable=SC2016 # expanded only inside the owned database container
    in_install docker compose exec -T postgres sh -c '
      psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT (SELECT count(*) FROM gp_deploy_fixture) = 10000 AND NOT EXISTS (SELECT FROM pg_database WHERE datname LIKE '\''gp_restore_%'\'' OR datname LIKE '\''gp_previous_%'\'')"
    ' | grep -qx t || fail 'failed PostgreSQL restore changed live rows or left temporary databases'
    echo 'PASS: failed staged PostgreSQL restore preserves live share and rows, names safety backup and cleans temporary DB'
  fi
  cp "$INSTALL/state/database-kind" "$WORK/selection-kind-before"
  if UPDATE_HEALTH_TIMEOUT=20 in_install ./upgrade.sh "$BAD" --yes >"$WORK/selection-rollback-$choice.log" 2>&1; then fail "$choice unhealthy candidate succeeded"; fi
  grep -q 'restoring the database from' "$WORK/selection-rollback-$choice.log" || fail "$choice rollback did not restore the database"
  grep -q 'rolling back to 1.0.1' "$WORK/selection-rollback-$choice.log" || fail "$choice rollback did not run"
  grep -q '"result":"rolled-back"' "$INSTALL/state/update.json" || fail "$choice rollback status missing"
  cmp "$INSTALL/state/database-kind" "$WORK/selection-kind-before" || fail "$choice rollback changed backend marker"
  check_share
  echo "PASS: $choice unhealthy real candidate rolls back to 1.0.1; API share and database-kind unchanged"
  in_install ./upgrade.sh "$NEXT"
  check_share
  grep -q '"result":"updated"' "$INSTALL/state/update.json" || fail 'update transaction did not run'
  [ "$(cat "$INSTALL/state/database-kind")" = "$choice" ] || fail 'update switched backend'
  echo "PASS: $choice fresh install, backup, restore, update preserve API-created share content"
  cp "$INSTALL/.env" "$WORK/selection-original.env"
  if [ "$choice" = sqlite ]; then other=postgres; else other=sqlite; fi
  if in_install ./install.sh --db "$other" >"$WORK/selection-install-refusal.log" 2>&1; then fail 'install backend switch accepted'; fi
  cmp "$INSTALL/.env" "$WORK/selection-original.env" || fail 'refused install modified .env'
  # The generator itself now refuses a marker mismatch, so change only the raw fixture config.
  # shellcheck disable=SC2016 # expanded by the installation shell
  in_install bash -c '. ./lib.sh; env_set GACHIPAD_DB "$1"' _ "$other"
  if in_install ./update.sh --version 1.0.3 --yes >"$WORK/selection-refusal.log" 2>&1; then fail 'marker backend switch accepted'; fi
  grep -q 'database backend change refused' "$WORK/selection-refusal.log" || fail 'marker refusal missing'
  rm "$INSTALL/state/database-kind"
  if in_install ./update.sh --version 1.0.3 --yes >"$WORK/selection-refusal.log" 2>&1; then fail 'non-empty old volume switch accepted'; fi
  grep -q "non-empty $choice volume" "$WORK/selection-refusal.log" || fail 'volume refusal missing'
  cp "$WORK/selection-original.env" "$INSTALL/.env"
  check_share
  echo "PASS: $choice marker and non-empty-volume backend-change refusal; original share retained"
  cleanup_stack
 done

echo 'selection: external PostgreSQL on shared gp-sql-pg (owned TCP relay across isolated Docker networks)'
prepare
docker exec gp-sql-pg createdb -U gp "$DB"
DB_CREATED=1
pg_ip="$(docker inspect gp-sql-pg --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
# The shared server is on Docker's default bridge. Only our relay joins both bridges; the
# shared container, its network memberships, volumes and configuration remain untouched.
docker network create --subnet 172.29.98.0/24 --label "com.docker.compose.project=$PROJECT" --label com.docker.compose.network=default "${PROJECT}_default" >/dev/null
docker run -d --name "$RELAY" --network bridge --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node node:22.23.3-slim -e '
  const net = require("node:net");
  net.createServer(c => { const s = net.connect(5432, process.argv[1]); c.pipe(s); s.pipe(c); c.on("error", () => s.destroy()); s.on("error", () => c.destroy()); }).listen(5432, "0.0.0.0");
' "$pg_ip" >/dev/null
RELAY_STARTED=1
docker network connect "${PROJECT}_default" "$RELAY"
# Credentials are the shared test fixture's throwaway credentials, never sent to stdout.
external_url="postgresql://gp:gp@$RELAY:5432/$DB"
DATABASE_URL="$external_url" in_install ./install.sh
[ "$(cat "$INSTALL/state/database-kind")" = external ] || fail 'external backend not selected'
services="$(in_install docker compose ps --services)"
! grep -Eq '^(mongo|postgres)$' <<<"$services" || fail 'external install started a bundled database'
seed
if in_install ./backup.sh "$WORK/external-backups" >"$WORK/external-notice.log" 2>&1; then fail 'external backup silently succeeded'; fi
grep -q 'no local backup was made' "$WORK/external-notice.log" || fail 'external backup notice missing'
[ ! -e "$WORK/external-backups" ] || fail 'external backup created an archive directory'
if in_install ./upgrade.sh "$NEXT" >"$WORK/external-refusal.log" 2>&1; then fail 'external update without backup acknowledgement succeeded'; fi
grep -q 'GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1' "$WORK/external-refusal.log" || fail 'external update guidance missing'
check_share
GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1 in_install ./upgrade.sh "$NEXT"
check_share
echo 'PASS: external shared PostgreSQL install and acknowledged update preserve API-created share; local backup refuses with guidance'
# Reuse only the owned relay and database; the earlier external fixture is discarded.
cleanup_stack
docker exec gp-sql-pg dropdb -U gp --if-exists --force "$DB"
docker exec gp-sql-pg createdb -U gp "$DB"
prepare
in_install ./install.sh --db mongodb
seed
UPLOAD="$(call /api/uploads -F "file=@$INSTALL/VERSION;filename=migration-fixture.txt" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["uploadId"])')"
call "/api/uploads/$UPLOAD" >"$WORK/migration-upload-before"
check_migration_data() {
  check_share
  call "/api/uploads/$UPLOAD" >"$WORK/migration-upload-after"
  cmp "$WORK/migration-upload-before" "$WORK/migration-upload-after" || fail 'migration lost upload bytes'
}
in_install ./migrate-db.sh --to sqlite --yes
[ "$(cat "$INSTALL/state/database-kind")" = sqlite ] || fail 'MongoDB to SQLite marker missing'
check_migration_data
docker volume inspect "${PROJECT}_mongo-data" >/dev/null
echo 'PASS: MongoDB -> SQLite retains API share, upload bytes and old MongoDB volume'

# Make the real npm copy complete, then inject a nonzero process exit at its boundary.
# This creates a populated new destination and exercises cleanup plus recovery of the old DB.
mkdir -p "$WORK/migration-bin"
REAL_DOCKER="$(command -v docker)"
export REAL_DOCKER
cat >"$WORK/migration-bin/docker" <<'INJECT'
#!/usr/bin/env bash
if [[ "$*" == *' api npm run --silent copy-db' ]]; then
  "$REAL_DOCKER" "${@:1:$(($# - 4))}" sh -c 'npm run --silent copy-db; exit 1'
  exit 1
fi
exec "$REAL_DOCKER" "$@"
INJECT
chmod +x "$WORK/migration-bin/docker"
cp -p "$INSTALL/.env" "$WORK/migration-before.env"
if PATH="$WORK/migration-bin:$PATH" in_install ./migrate-db.sh --to postgres --yes >"$WORK/migration-failed.log" 2>&1; then
  fail 'injected copy failure succeeded'
else status=$?; fi
[ "$status" = 1 ] || fail 'injected copy failure lost exit 1'
grep -q 'Result: success' "$WORK/migration-failed.log" || fail 'injected failure did not execute real copy'
grep -q 'copy exited 1' "$WORK/migration-failed.log" || fail 'copy failure was not injected'
grep -q 'destination may hold a partial copy' "$WORK/migration-failed.log" || fail 'partial destination guidance missing'
cmp "$INSTALL/.env" "$WORK/migration-before.env" || fail 'copy failure changed source env'
[ "$(cat "$INSTALL/state/database-kind")" = sqlite ] || fail 'copy failure changed source marker'
if docker volume inspect "${PROJECT}_postgres-data" >/dev/null 2>&1; then fail 'failed migration retained a new partial volume'; fi
check_migration_data
echo 'PASS: injected copy process failure restarts old SQLite with share/upload; new populated target volume removed'

in_install ./migrate-db.sh --to postgres --yes
[ "$(cat "$INSTALL/state/database-kind")" = postgres ] || fail 'SQLite to PostgreSQL marker missing'
check_migration_data
docker volume inspect "${PROJECT}_gachipad-data" >/dev/null
echo 'PASS: SQLite -> PostgreSQL retains API share, upload bytes and old SQLite volume'
cp -p "$INSTALL/.env" "$WORK/migration-before.env"
if in_install ./migrate-db.sh --to mongodb --yes >"$WORK/migration-refused.log" 2>&1; then
  fail 'migration into nonempty MongoDB succeeded'
else status=$?; fi
[ "$status" = 2 ] || fail 'nonempty destination refusal lost exit 2'
grep -q 'Result: refused' "$WORK/migration-refused.log" || fail 'real copy tool did not refuse'
cmp "$INSTALL/.env" "$WORK/migration-before.env" || fail 'refusal changed source env'
docker volume inspect "${PROJECT}_mongo-data" >/dev/null
check_migration_data
echo 'PASS: real nonempty destination refusal returns 2 and retains both backends and share/upload'
# Old volumes retained by migration must not prevent later normal updates.
in_install ./upgrade.sh "$NEXT"
check_migration_data
in_install ./migrate-db.sh --to external --database-url "$external_url" --yes
[ "$(cat "$INSTALL/state/database-kind")" = external ] || fail 'PostgreSQL to external marker missing'
check_migration_data
docker volume inspect "${PROJECT}_postgres-data" >/dev/null
if in_install ./migrate-db.sh --to external --database-url "$external_url" --yes >"$WORK/migration-identical.log" 2>&1; then
  fail 'identical external migration succeeded'
fi
grep -q 'URLs are identical' "$WORK/migration-identical.log" || fail 'identical external refusal missing'
check_migration_data
echo 'PASS: PostgreSQL -> external shared PostgreSQL retains share/upload and old volume; identical URL refuses'
docker rm -f "$RELAY" >/dev/null
RELAY_STARTED=0
cleanup_stack
docker exec gp-sql-pg dropdb -U gp --if-exists --force "$DB"
DB_CREATED=0
echo 'verify-databases: all checks passed'
