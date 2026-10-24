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
  local path
  path="$(pwd -P)/state/install.lock"
  mkdir -p state
  INSTALL_LOCK_OWNED=0
  if [ "${CODESH_LOCK_PATH:-}" = "$path" ] && [ -n "${CODESH_LOCK_PID:-}" ] &&
    kill -0 "$CODESH_LOCK_PID" 2>/dev/null &&
    [ "$(cat "$path.d/owner" 2>/dev/null)" = "$CODESH_LOCK_PID" ]; then
    if [ "${CODESH_LOCK_KIND:-}" = mkdir ]; then return; fi
    if [ "${CODESH_LOCK_KIND:-}" = flock ] && [ -e /proc/self/fd/9 ] &&
      [ /proc/self/fd/9 -ef "$path" ]; then return; fi
  fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$path"
    flock -n 9 || die "another update, upgrade, backup or restore is running"
    CODESH_LOCK_KIND=flock
  else
    CODESH_LOCK_KIND="mkdir"
  fi
  # Also arbitrate through mkdir when flock exists, so callers with different PATHs cannot
  # bypass one another by selecting different primitives.
  mkdir "$path.d" 2>/dev/null || die "installation is locked ($path.d); verify its owner before removing a stale lock"
  printf '%s\n' "$$" >"$path.d/owner"
  INSTALL_LOCK_OWNED=1
  export CODESH_LOCK_PATH="$path" CODESH_LOCK_PID="$$" CODESH_LOCK_KIND
}

install_unlock() {
  if [ "${INSTALL_LOCK_OWNED:-0}" = 1 ]; then
    rm -f "$CODESH_LOCK_PATH.d/owner"
    rmdir "$CODESH_LOCK_PATH.d"
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
  host="${site#*://}"; host="${host%%/*}"; host="${host%%:*}"
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
  local id
  docker compose stop caddy || return 1
  docker compose stop --timeout 40 api collab || return 1
  for id in $(docker compose ps -a -q collab); do
    [ "$(docker inspect --format '{{.State.ExitCode}} {{.State.OOMKilled}}' "$id")" = '0 false' ] || {
      echo "collab did not shut down cleanly; refusing to back up" >&2; return 1;
    }
  done
}

# mongo_transfer dump|restore: mongodump to stdout, or mongorestore from stdin, as the root user
# inside the mongo container. The password goes through a private config file, never arguments.
mongo_transfer() {
  # shellcheck disable=SC2016 # expanded by the shell in the container
  docker compose exec -T mongo sh -c '
    set -eu
    umask 077
    cfg="$(mktemp)"
    trap "rm -f $cfg" EXIT
    mongosh --nodb --quiet --eval "print(\"password: \" + JSON.stringify(process.env.MONGO_INITDB_ROOT_PASSWORD))" </dev/null >"$cfg"
    set -- --quiet --host localhost --username codesh --authenticationDatabase admin --config "$cfg" --archive --gzip
    case "$0" in
      dump) mongodump "$@" --db codesh ;;
      restore)
        # --drop alone only drops collections in the archive, leaving failed migrations behind.
        mongosh --quiet --host localhost --eval "if (!db.getSiblingDB(\"admin\").auth(\"codesh\", process.env.MONGO_INITDB_ROOT_PASSWORD)) throw new Error(\"auth failed\"); db.getSiblingDB(\"codesh\").dropDatabase()" >/dev/null
        mongorestore "$@" --drop --nsInclude "codesh.*" ;;
      *) exit 2 ;;
    esac
  ' "$1"
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
