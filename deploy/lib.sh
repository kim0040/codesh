# shellcheck shell=bash
# Shared helpers of the deploy scripts. Sourced, not executed.

die() { echo "$(basename "$0"): $*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
}

# env_get NAME [default]: value of NAME in .env (last assignment wins)
env_get() {
  local value
  value="$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1)"
  # legacy codesh name (1.0.x); remove in 2.0
  if [ -z "$value" ] && [[ "$1" == GACHIPAD_* ]]; then
    value="$(sed -n "s/^CODESH_${1#GACHIPAD_}=//p" .env 2>/dev/null | tail -n 1)"
  fi
  printf '%s' "${value:-${2:-}}"
}

# env_set NAME VALUE: replaces or appends NAME in .env
env_set() {
  if grep -q "^$1=" .env; then
    sed "s|^$1=.*|$1=$2|" .env >.env.tmp && cat .env.tmp >.env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

# One installation-wide lock, inherited only by children of its holder. The mkdir fallback
# deliberately leaves a stale lock after SIGKILL: an operator must verify the PID before removal.
install_lock() {
  local path owner boot boot_time lock_time
  path="$(pwd -P)/state/install.lock"
  mkdir -p state
  INSTALL_LOCK_OWNED=0
  if [ "${GACHIPAD_LOCK_PATH:-}" = "$path" ] && [ -n "${GACHIPAD_LOCK_PID:-}" ] &&
    kill -0 "$GACHIPAD_LOCK_PID" 2>/dev/null &&
    [ "$(cat "$path.d/owner" 2>/dev/null)" = "$GACHIPAD_LOCK_PID" ]; then
    if [ "${GACHIPAD_LOCK_KIND:-}" = mkdir ]; then return; fi
    if [ "${GACHIPAD_LOCK_KIND:-}" = flock ] && [ -e /proc/self/fd/9 ] &&
      [ /proc/self/fd/9 -ef "$path" ]; then return; fi
  fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$path"
    flock -n 9 || die "another update, upgrade, backup or restore is running"
    GACHIPAD_LOCK_KIND=flock
  else
    GACHIPAD_LOCK_KIND="mkdir"
  fi
  # Also arbitrate through mkdir when flock exists, so callers with different PATHs cannot
  # bypass one another by selecting different primitives.
  if ! mkdir "$path.d" 2>/dev/null; then
    owner="$(cat "$path.d/owner" 2>/dev/null || true)"
    boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
    boot_time="$(awk '$1 == "btime" {print $2}' /proc/stat 2>/dev/null || true)"
    lock_time="$(stat -c %Y "$path.d" 2>/dev/null || true)"
    if [ "$GACHIPAD_LOCK_KIND" = flock ] && {
      { [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; } ||
      { [ -n "$boot" ] && [ -f "$path.d/boot" ] && [ "$(cat "$path.d/boot")" != "$boot" ]; } ||
      { [[ "$boot_time" =~ ^[0-9]+$ && "$lock_time" =~ ^[0-9]+$ ]] && [ "$lock_time" -lt "$boot_time" ]; };
    }; then
      rm -f "$path.d/owner" "$path.d/boot"
      rmdir "$path.d" || die "cannot reclaim stale installation lock"
      mkdir "$path.d" || die "cannot reclaim stale installation lock"
    else
      die "installation is locked ($path.d); verify its owner before removing a stale lock"
    fi
  fi
  printf '%s\n' "$$" >"$path.d/owner"
  cat /proc/sys/kernel/random/boot_id >"$path.d/boot" 2>/dev/null || true
  INSTALL_LOCK_OWNED=1
  export GACHIPAD_LOCK_PATH="$path" GACHIPAD_LOCK_PID="$$" GACHIPAD_LOCK_KIND
}

install_unlock() {
  if [ "${INSTALL_LOCK_OWNED:-0}" = 1 ]; then
    rm -f "$GACHIPAD_LOCK_PATH.d/owner" "$GACHIPAD_LOCK_PATH.d/boot"
    rmdir "$GACHIPAD_LOCK_PATH.d"
  fi
}

# wait_healthy [seconds] [path]: local Caddy, with the configured site's Host and TLS SNI.
# curl is required: wget variants differ in redirect, TLS routing and total-deadline semantics.
wait_healthy() {
  local port url deadline remaining code site host scheme=http
  command -v curl >/dev/null 2>&1 || die "curl is required for bounded health checks"
  site="$(env_get SITE_ADDRESS :80)"
  case "$site" in
    :*|http://*) port="$(env_get HTTP_PORT 80)" ;;
    *) scheme=https; port="$(env_get HTTPS_PORT 443)" ;;
  esac
  host="${site%%,*}"; host="${host#*://}"; host="${host%%/*}"; host="${host%%:*}"
  host="${host:-127.0.0.1}"
  url="$scheme://$host:$port${2:-/healthz}"
  deadline=$((SECONDS + ${1:-120}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' \
      --resolve "$host:$port:127.0.0.1" --connect-timeout "$remaining" --max-time "$remaining" \
      "$url" 2>/dev/null)" || code=000
    if [[ "$code" =~ ^2[0-9][0-9]$ ]] && [ "$SECONDS" -lt "$deadline" ]; then return 0; fi
    [ "$SECONDS" -lt "$deadline" ] && sleep 1
  done
  echo "no healthy answer from $url within ${1:-120}s; recent logs:" >&2
  docker compose logs --tail 20 >&2 || true
  return 1
}

# Check the API before opening ingress. Node is already in the installed API image.
wait_api() {
  local deadline remaining path
  deadline=$((SECONDS + ${1:-120}))
  for path in /healthz /readyz; do
    while :; do
      remaining=$((deadline - SECONDS))
      [ "$remaining" -gt 0 ] || return 1
      if docker compose exec -T api node -e '
        fetch("http://127.0.0.1:3001" + process.argv[1], {
          redirect: "manual", signal: AbortSignal.timeout(Number(process.argv[2]) * 1000)
        }).then(r => process.exit(r.status >= 200 && r.status < 300 ? 0 : 1))
          .catch(() => process.exit(1));
      ' "$path" "$remaining" && [ "$SECONDS" -lt "$deadline" ]; then break; fi
      [ "$SECONDS" -lt "$deadline" ] && sleep 1
    done
  done
}

# Stop ingress first; compose stop waits for collab's SIGTERM flush and process exit.
# A killed/failed collab must never be mistaken for a consistent backup boundary.
stop_writes() {
  local id service
  docker compose stop caddy || return 1
  docker compose stop --timeout 40 api collab || return 1
  # A manual restore deliberately replaces this DB, including after a crashed/OOM writer.
  [ "${1:-}" != restore ] || return 0
  for service in api collab; do
    for id in $(docker compose ps -a -q "$service"); do
      [ "$(docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$id")" = '0 false' ] || {
        echo "$service did not shut down cleanly; refusing to back up" >&2; return 1;
      }
    done
  done
}

# mongo_transfer dump|validate|restore: Mongo tools as the root user, archive on stdin/stdout.
# inside the mongo container. The password goes through a private config file, never arguments.
mongo_transfer() {
  # Names come from this installation's .env, not from the container: a container created before
  # a partly finished update still carries the old environment (or none of these variables).
  local db user
  db="$(env_get MONGO_DATABASE)" user="$(env_get MONGO_ROOT_USER)"
  # legacy codesh name (1.0.x); remove in 2.0
  if [ -z "$db" ] || [ -z "$user" ]; then
    if [ -n "$(env_get CODESH_VERSION)" ] || [ "$(env_get GACHIPAD_LEGACY_INSTALL)" = 1 ]; then
      db="${db:-codesh}" user="${user:-codesh}"
    else db="${db:-gachipad}" user="${user:-gachipad}"; fi
  fi
  # shellcheck disable=SC2016 # expanded by the shell in the container
  docker compose exec -T -e MONGO_DATABASE="$db" -e MONGO_INITDB_ROOT_USERNAME="$user" mongo sh -c '
    set -eu
    umask 077
    cfg="$(mktemp)"
    trap "rm -f $cfg" EXIT
    mongosh --nodb --quiet --eval "print(\"password: \" + JSON.stringify(process.env.MONGO_INITDB_ROOT_PASSWORD))" </dev/null >"$cfg"
    set -- --quiet --host localhost --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin --config "$cfg" --archive --gzip
    # legacy codesh name (1.0.x); remove in 2.0
    # Restore either product namespace into this installation only, including on a fresh host.
    if [ "$0" != dump ]; then
      set -- "$@" --nsInclude "${MONGO_DATABASE:-gachipad}.*" --nsInclude "gachipad.*" --nsInclude "codesh.*" \
        --nsFrom "\$database\$.\$collection\$" --nsTo "${MONGO_DATABASE:-gachipad}.\$collection\$"
    fi
    case "$0" in
      dump) mongodump "$@" --db "${MONGO_DATABASE:-gachipad}" ;;
      validate) mongorestore "$@" --dryRun ;;
      restore)
        # --drop alone only drops collections in the archive, leaving failed migrations behind.
        mongosh --quiet --host localhost --eval "if (!db.getSiblingDB(\"admin\").auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) throw new Error(\"auth failed\"); db.getSiblingDB(process.env.MONGO_DATABASE || \"gachipad\").dropDatabase()" >/dev/null
        mongorestore "$@" --drop ;;
      *) exit 2 ;;
    esac
  ' "$1"
}

# Validate twice before the destructive operation, and retain the current DB even if restore
# subsequently fails (OOM, server mismatch, disk pressure). Call only with all writers stopped.
mongo_restore() {
  gzip -t -- "$1" || { echo "invalid gzip archive; database unchanged" >&2; return 1; }
  mongo_transfer validate <"$1" || { echo "mongorestore dry run failed; database unchanged" >&2; return 1; }
  # Use this engine's validated dump even after rollback restored an older backup.sh.
  mongo_backup ./backups >&2 || return 1
  mongo_transfer restore <"$1"
}

mongo_backup() (
  set -euo pipefail
  umask 077
  local dir="$1" part file
  mkdir -p "$dir" || return 1
  part="$(mktemp "$dir/.backup.XXXXXX")" || return 1
  file="$dir/gachipad-$(date +%Y%m%d-%H%M%S)-${part##*.}.archive.gz"
  trap 'rm -f "$part"' EXIT
  mongo_transfer dump >"$part" || return 1
  [ -s "$part" ] || { echo "mongodump produced no data" >&2; return 1; }
  gzip -t -- "$part" || { echo "mongodump archive is corrupt; backup not published" >&2; return 1; }
  chmod 600 "$part" && mv "$part" "$file" || return 1
  echo "backup: $file ($(wc -c <"$file" | tr -d ' ') bytes)"
)

# legacy codesh name (1.0.x); remove in 2.0
# Reserve space for both the pre-update dump and the safety dump used during recovery.
backup_space() {
  local latest bytes free
  latest="$(find backups -maxdepth 1 \( -name 'gachipad-*.archive.gz' -o -name 'codesh-*.archive.gz' \) -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2- || true)"
  [ -n "$latest" ] || return 0
  bytes="$(wc -c <"$latest")" || return 1
  free="$(df -Pk backups | awk 'NR == 2 {print $4}')" || return 1
  [ "$((free * 1024))" -ge "$((bytes * 2))" ] || {
    echo "insufficient free space: need twice the last backup size before maintenance" >&2; return 1;
  }
}

# SHA-256 detects corruption and mismatch; obtain the checksum via a trusted delivery channel.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1;
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

verify_archive() {
  local expected manifest
  if [ -f "$1.sha256" ]; then
    expected="$(awk 'NR == 1 {print $1}' "$1.sha256")"
  else
    manifest="$(dirname "$1")/SHA256SUMS"
    [ -f "$manifest" ] || die "missing checksum: $1.sha256 or $manifest"
    expected="$(awk -v f="$(basename "$1")" '$2 == f || $2 == "*" f || $2 == "./" f {print $1}' "$manifest")"
  fi
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die "invalid archive checksum"
  [ "$(sha256_file "$1")" = "$expected" ] || die "bundle checksum mismatch"
}

verify_bundle() {
  local dir="$1"
  [ -f "$dir/SHA256SUMS" ] || die "bundle SHA256SUMS is missing"
  (cd "$dir" && {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum --quiet --strict -c SHA256SUMS;
    else shasum -a 256 --quiet -c SHA256SUMS; fi
  }) || die "bundle content checksum mismatch"
}

# legacy codesh name (1.0.x); remove in 2.0
# Environment compatibility is startup-only and warns once per run (children inherit the marker),
# without printing any values. Only real environment variables warn: the migration comments the
# old lines out of .env, and env_get still reads an old-style .env silently.
legacy_env_names=()
while read -r legacy_env_name; do
  [[ "$legacy_env_name" == CODESH_* ]] || continue
  legacy_env_names+=("$legacy_env_name")
  new_env_name="GACHIPAD_${legacy_env_name#CODESH_}"
  if [ -z "${!new_env_name+x}" ]; then export "$new_env_name=${!legacy_env_name}"; fi
done < <(compgen -e)
if [ "${#legacy_env_names[@]}" -gt 0 ] && [ -z "${GACHIPAD_LEGACY_ENV_WARNED:-}" ]; then
  export GACHIPAD_LEGACY_ENV_WARNED=1
  echo "warning: legacy CODESH_ settings are deprecated; use GACHIPAD_ settings" >&2
fi
