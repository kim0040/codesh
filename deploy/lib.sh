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
  value="$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 || true)"
  # legacy codesh name (1.0.x); remove in 2.0
  if [ -z "$value" ] && [[ "$1" == GACHIPAD_* ]]; then
    value="$(sed -n "s/^CODESH_${1#GACHIPAD_}=//p" .env 2>/dev/null | tail -n 1 || true)"
  fi
  # Compose single quotes keep passwords containing $, # or spaces literal.
  if [[ "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\'/\'}"
  elif [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "${value:-${2:-}}"
}

# env_set NAME VALUE: replaces or appends NAME in .env
env_set() {
  local name="$1" value="$2" tmp line found=0
  case "$name" in DATABASE_URL | GACHIPAD_DATABASE_URL)
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name must be a single line"
    [ -z "$value" ] || value="'${value//\'/\\\'}'"
    ;;
  esac
  tmp="$(mktemp .env.XXXXXX)" || return 1
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == "$name="* ]]; then
        if [ "$found" = 0 ]; then printf '%s=%s\n' "$name" "$value" >>"$tmp"; found=1; fi
      else printf '%s\n' "$line" >>"$tmp"; fi
    done <.env
  fi
  [ "$found" = 1 ] || printf '%s=%s\n' "$name" "$value" >>"$tmp"
  chmod 600 "$tmp" && mv "$tmp" .env
}

# Linux host networking is required; Docker Desktop's Linux VM cannot advertise the host.
mdns_supported() {
  [ "$(uname -s)" = Linux ] || return 1
  [ "$(docker info --format '{{.OSType}}' 2>/dev/null)" = linux ] || return 1
  case "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)" in *[Dd]esktop*) return 1 ;; esac
  if [ -r /proc/version ] && grep -qi microsoft /proc/version; then return 1; fi
  local endpoint="${DOCKER_HOST:-}"
  if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "$endpoint" ]; then
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || return 1
  fi
  case "$endpoint" in unix://*) return 0 ;; *) return 1 ;; esac
}

mdns_image() {
  printf '%s/gachipad-mdns:%s' "$(env_get GACHIPAD_REGISTRY ghcr.io/kim0040)" "$(env_get GACHIPAD_VERSION "$(cat VERSION 2>/dev/null)")"
}

# Restore the optional helper after an updater with a fixed legacy file list.
mdns_install_tools() (
  local bundle="$1" stage status=0
  [ -f .env ] || die '.env is missing'
  verify_archive "$bundle"
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"; rm -f ./mdns.sh.new' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  tar xzf "$bundle" -C "$stage" || status=$?
  if [ "$status" = 0 ]; then
    local source
    source="$(find "$stage" -maxdepth 2 -name mdns.sh -exec dirname {} \; | head -n 1)"
    if [ -z "$source" ] || ! (verify_bundle "$source") ||
      [ "$(cat "$source/VERSION")" != "$(env_get GACHIPAD_VERSION)" ] || [ ! -f "$source/images.tar" ]; then
      echo 'mdns: need the verified offline bundle matching the installed version' >&2
      status=1
    elif docker load -i "$source/images.tar" && docker image inspect "$(mdns_image)" >/dev/null 2>&1 && cp -p "$source/mdns.sh" ./mdns.sh.new && mv ./mdns.sh.new ./mdns.sh; then
      echo 'mdns: tools installed; run ./mdns.sh enable'
    else status=1; fi
  fi
  rm -rf "$stage"
  return "$status"
)

mdns_require_image() {
  local image
  image="$(mdns_image)"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "mdns: local image $image is missing; trying the registry. For offline use: ./update.sh --mdns-tools /path/to/matching-bundle.tar.gz" >&2
    if ! docker compose --profile mdns pull mdns || ! docker image inspect "$image" >/dev/null 2>&1; then
      echo 'mdns: cannot probe or enable without the local image; load the matching offline bundle with the command above.' >&2
      return 1
    fi
  fi
}

mdns_run() {
  # A Node deadline bounds the query; timeout also bounds Docker startup. Never pull at install time.
  command -v timeout >/dev/null 2>&1 || return 2
  local name="gachipad-mdns-probe-$$" status=0
  timeout -k 1 6 docker run --rm --pull never --name "$name" --network host --read-only \
    --cap-drop ALL --security-opt no-new-privileges -e "MDNS_IP=${MDNS_IP:-$(env_get MDNS_IP)}" \
    "$(mdns_image)" node index.mjs "$@" 2>/dev/null || status=$?
  if [ "$status" = 124 ] || [ "$status" = 137 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
  fi
  return "$status"
}

mdns_profile() {
  local enabled="$1" profiles profile result=""
  profiles="$(env_get COMPOSE_PROFILES)"
  local -a entries=()
  IFS=',' read -r -a entries <<<"$profiles"
  for profile in ${entries[@]+"${entries[@]}"}; do
    profile="${profile#"${profile%%[![:space:]]*}"}"
    profile="${profile%"${profile##*[![:space:]]}"}"
    if [ -z "$profile" ] || [ "$profile" = mdns ]; then continue; fi
    [ -z "$result" ] || result+=,
    result+="$profile"
  done
  if [ "$enabled" = 1 ]; then [ -z "$result" ] || result+=,; result+=mdns; fi
  env_set COMPOSE_PROFILES "$result"
  COMPOSE_PROFILES="$result"; export COMPOSE_PROFILES
}

mdns_choose_name() {
  local original="${MDNS_HOSTNAME:-$(env_get MDNS_HOSTNAME gachipad.local)}" candidate status number
  if [[ ! "$original" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.local$ ]] ||
    [ "${#original}" -gt 66 ]; then die "MDNS_HOSTNAME must be a single-label .local host name (at most 60 characters before .local)"; fi
  candidate="$original"
  for number in {1..10}; do
    status=0
    mdns_run --probe "$candidate" >/dev/null || status=$?
    case "$status" in
      0)
        if [ "$candidate" != "$original" ]; then echo "mdns: $original is in use; using $candidate."; fi
        env_set MDNS_HOSTNAME "$candidate"
        MDNS_HOSTNAME="$candidate"; export MDNS_HOSTNAME
        return ;;
      10) candidate="${original%.local}-$((number + 1)).local" ;;
      125 | 126 | 127) echo "mdns: local probe image or command unavailable; keeping $original (name was not checked)." >&2; break ;;
      124 | 137) echo "mdns: name check timed out; keeping $original (check for conflicts on your network)." >&2; break ;;
      *) echo "mdns: name check failed; keeping $original (check for conflicts on your network)." >&2; break ;;
    esac
  done
  if [ "$status" = 10 ]; then echo "mdns: no free name found in 10 attempts; keeping $original (check for conflicts on your network)." >&2; fi
  env_set MDNS_HOSTNAME "$original"
  MDNS_HOSTNAME="$original"; export MDNS_HOSTNAME
}

mdns_check_aliases() {
  local alias status aliases
  aliases="${MDNS_ALIASES:-$(env_get MDNS_ALIASES)}"
  local -a names=()
  IFS=',' read -r -a names <<<"$aliases"
  for alias in ${names[@]+"${names[@]}"}; do
    [ -n "$alias" ] || continue
    status=0; mdns_run --probe "$alias" >/dev/null || status=$?
    case "$status" in
      0) ;;
      10) echo "mdns: alias $alias is in use by another host; remove or change MDNS_ALIASES before relying on it." >&2 ;;
      *) echo "mdns: alias $alias could not be checked; confirm it on your network." >&2 ;;
    esac
  done
}

select_mdns() {
  local choice="$1" answer
  case "$choice" in auto | 0 | 1) ;; *) die "GACHIPAD_MDNS must be 0 or 1" ;; esac
  if ! mdns_supported; then
    echo "mdns: disabled; a native Linux Docker host is required for multicast host networking."
    mdns_profile 0
    return
  fi
  if [ "$choice" = auto ]; then
    choice=1
    if [ -t 0 ]; then
      read -r -p "Enable short name ${MDNS_HOSTNAME:-$(env_get MDNS_HOSTNAME gachipad.local)} on this network? [Y/n]: " answer || answer=""
      case "$answer" in n | N | no | NO) choice=0 ;; esac
    fi
  fi
  if [ "$choice" = 1 ]; then mdns_choose_name; mdns_check_aliases; fi
  mdns_profile "$choice"
}

mdns_enabled() {
  case ",${COMPOSE_PROFILES-$(env_get COMPOSE_PROFILES)}," in *,mdns,*) return 0 ;; *) return 1 ;; esac
}

mdns_host_addresses() {
  if [ "$(uname -s)" = Linux ] && command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '
      $2 !~ /^(docker|br-|veth|virbr)/ {split($4, address, "/"); print address[1]}'
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '
      /^[^[:space:]]/ {interface=$1}
      $1 == "inet" && $2 != "127.0.0.1" && interface !~ /^(docker|br-|veth|virbr)/ {print $2}'
  fi
}

mdns_addresses() {
  local port suffix="" address site public direct=0
  port="$(env_get HTTP_PORT 80)"
  [ "$port" = 80 ] || suffix=":$port"
  site="$(env_get SITE_ADDRESS :80)"
  public="$(env_get PUBLIC_URL)"
  case "$site" in :* | http:// | http://:*) direct=1 ;; esac
  case "$public" in https://*) direct=0 ;; esac
  if mdns_enabled; then
    if [ "$direct" = 1 ]; then
      echo "mdns: open http://$(env_get MDNS_HOSTNAME gachipad.local)$suffix"
    else
      echo "mdns: $(env_get MDNS_HOSTNAME gachipad.local) advertised; named sites need a matching SITE_ALIASES entry (and a certificate for HTTPS; see tls/README.md)."
    fi
    if [ "$direct" = 1 ]; then
      echo 'mdns: some networks and Android devices do not resolve .local; use a server IP address then.'
    else
      echo 'mdns: some networks and Android devices do not resolve .local; use the configured site name or an IP covered by its HTTP/TLS configuration.'
    fi
  fi
  if ! mdns_supported; then
    echo 'install: automatic server IP discovery requires a local native Linux Docker host.'
    return
  fi
  while IFS= read -r address; do
    [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if [ "$direct" = 1 ]; then echo "install: server address http://$address$suffix"
    else echo "install: server IP $address (use the configured site name and its HTTP/TLS settings)"; fi
  done < <(mdns_host_addresses || true)
}

# database_kind reads the effective deployment choice without ever printing a database URL.
database_kind() {
  local url kind
  url="${DATABASE_URL:-$(env_get DATABASE_URL)}"
  if [ -n "$url" ]; then
    validate_database_url "$url" || die "DATABASE_URL has an unsupported scheme"
    if [[ "$url" == sqlite:* ]]; then printf sqlite; else printf external; fi
    return
  fi
  kind="${GACHIPAD_DB:-$(env_get GACHIPAD_DB)}"
  if [ -z "$kind" ]; then
    if grep -Eq '^MONGO_[A-Z0-9_]+=' .env 2>/dev/null; then kind=mongodb; else kind=sqlite; fi
  fi
  case "$kind" in sqlite | postgres | mongodb | external) printf '%s' "$kind" ;;
    *) die "GACHIPAD_DB must be sqlite, postgres, mongodb or external" ;;
  esac
}

validate_database_url() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" == *:* ]] || return 1
  local scheme="${1%%:*}"
  case "$scheme" in
    sqlite | postgres | postgresql | mysql | mariadb | mongodb | mongodb+srv) return 0 ;;
    *) return 1 ;;
  esac
}

database_project() {
  local fallback=gachipad
  [ -z "$(env_get CODESH_VERSION)" ] || fallback=codesh
  printf '%s' "${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME "${GACHIPAD_PROJECT:-$(env_get GACHIPAD_PROJECT "$fallback")}")}"
}

database_volume_suffix() {
  case "$1" in sqlite) printf gachipad-data ;; postgres) printf postgres-data ;;
    mongodb) printf mongo-data ;; esac
}

database_volume_nonempty() {
  local volume="$1" kind="${2:-}" result url image registry version
  docker volume inspect "$volume" >/dev/null 2>&1 || return 1
  url="$(env_get GACHIPAD_DATABASE_URL)"
  [[ "$url" == sqlite:* ]] || url=""
  registry="$(sed -n 's/^GACHIPAD_REGISTRY=//p' .env.example 2>/dev/null | tail -n 1)"
  registry="${registry:-$(env_get GACHIPAD_REGISTRY ghcr.io/kim0040)}"
  version="$(cat VERSION 2>/dev/null || env_get GACHIPAD_VERSION)"
  image="$registry/gachipad-api:$version"
  result="$(GACHIPAD_PROBE_SQLITE_URL="$url" docker run --rm --pull never --network none --read-only --security-opt no-new-privileges --cap-drop ALL --user 0 --cap-add DAC_OVERRIDE -v "$volume:/probe:ro" -e GACHIPAD_PROBE_SQLITE_URL \
    --entrypoint node "$image" -e '
      const { readdirSync, existsSync } = require("node:fs");
      const url = process.env.GACHIPAD_PROBE_SQLITE_URL ?? "";
      const path = url.startsWith("sqlite:") ? (url.startsWith("sqlite://")
        ? decodeURIComponent(new URL(url).pathname) : url.slice(7)) : "/data/gachipad.db";
      const relative = path.startsWith("/data/") ? path.slice(6) : "gachipad.db";
      const nonempty = process.argv[1] === "sqlite"
        ? existsSync("/probe/gachipad.db") || existsSync(`/probe/${relative}`)
        : readdirSync("/probe").length > 0;
      process.stdout.write(nonempty ? "nonempty" : "empty");
    ' "$kind" 2>/dev/null)" || die "cannot inspect existing database volume $volume; refusing to change the database backend"
  [ "$result" = nonempty ]
}

# A migration snapshot is different from update.sh's rollback directory. Never delete the
# transaction until the saved backend is healthy; a hard crash can interrupt the env/marker pair.
migration_recovery_hint() {
  local stage="${1:-$(sed -n 's/^snapshot=//p' state/transaction 2>/dev/null | head -n1)}"
  echo 'migrate-db: first clear shell overrides: unset DATABASE_URL GACHIPAD_DB COMPOSE_PROFILES GACHIPAD_DATABASE_URL'
  echo 'migrate-db: keep writers stopped: docker compose stop caddy api collab'
  if [[ "$stage" =~ ^\.env\.migrate-db\.[A-Za-z0-9]+$ ]] && [ -f "$stage/original.env" ]; then
    printf 'migrate-db: restore configuration: cp -p %q/original.env .env\n' "$stage"
    if [ -f "$stage/original.kind" ]; then
      printf 'migrate-db: restore marker: cp -p %q/original.kind state/database-kind\n' "$stage"
    else echo 'migrate-db: if there was no marker before: rm -f state/database-kind'; fi
    echo 'migrate-db: restart the saved backend and check shares/uploads: docker compose up -d --pull never --wait'
    printf 'migrate-db: only after recovery succeeds, remove the snapshot and the transaction marker: rm -rf -- %q state/transaction\n' "$stage"
  else
    echo 'migrate-db: locate the private .env.migrate-db.*/original.env snapshot; restore it and its original.kind (or remove the marker if originally absent), restart the saved backend and check shares/uploads before removing the snapshot and state/transaction.'
  fi
  echo 'migrate-db: inspect any destination separately; retained data may include writes accepted before rollback. Verify stale lock ownership before removing state/install.lock.d.'
}

database_migration_hint() {
  if [ -f migrate-db.sh ]; then
    printf 'use ./migrate-db.sh to copy data and switch backends.'
  else
    printf 'extract migrate-db.sh from the verified deployment bundle into this installation before migrating.'
  fi
}

# Refuse a backend switch before Compose can start a new database beside old data.
assert_database_backend() {
  local selected marker project kind volume
  selected="$(database_kind)"
  marker="$(cat state/database-kind 2>/dev/null || true)"
  if [ -n "$marker" ] && [ "$marker" != "$selected" ]; then
    die "database backend change refused ($marker -> $selected); $(database_migration_hint)"
  fi
  # A successful migration deliberately retains the previous backend volumes.
  [ "$marker" != "$selected" ] || return 0
  project="$(database_project)"
  for kind in sqlite postgres mongodb; do
    [ "$kind" = "$selected" ] && continue
    volume="${project}_$(database_volume_suffix "$kind")"
    if database_volume_nonempty "$volume" "$kind"; then
      die "database backend change refused: non-empty $kind volume $volume exists while $selected is selected. $(database_migration_hint)"
    fi
  done
}

record_database_backend() {
  mkdir -p state
  printf '%s\n' "$(database_kind)" >state/database-kind.tmp
  chmod 600 state/database-kind.tmp
  mv state/database-kind.tmp state/database-kind
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
    flock -n 9 || die "another update, upgrade, backup, restore or migration is running"
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

database_start() {
  local timeout="${1:-120}"
  case "$(database_kind)" in
    mongodb)
      docker compose up -d --pull never --wait --wait-timeout "$timeout" mongo valkey &&
        docker compose run --rm --no-deps --pull never -T mongo-users
      ;;
    postgres) docker compose up -d --pull never --wait --wait-timeout "$timeout" postgres valkey ;;
    sqlite | external) docker compose up -d --pull never --wait --wait-timeout "$timeout" valkey ;;
  esac
}

sqlite_backup() (
  set -euo pipefail
  umask 077
  local dir="$1" part file
  mkdir -p "$dir" || return 1
  part="$(mktemp "$dir/.backup.XXXXXX")" || return 1
  file="$dir/gachipad-$(date +%Y%m%d-%H%M%S)-${part##*.}.archive.gz"
  trap 'rm -f "$part"' EXIT
  docker compose run --rm --no-deps -T --entrypoint node api --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { createReadStream, mkdtempSync, rmSync, readdirSync, statSync, statfsSync } from "node:fs";
    import { basename, dirname, join } from "node:path";
    import { pipeline } from "node:stream/promises";
    const url = process.env.DATABASE_URL ?? "sqlite:///data/gachipad.db";
    const source = url.startsWith("sqlite:") && !url.startsWith("sqlite://")
      ? url.slice("sqlite:".length) : decodeURIComponent(new URL(url).pathname);
    const dataDirectory = dirname(source);
    for (const name of readdirSync(dataDirectory)) {
      if (name.startsWith(".gachipad-backup-") || name.startsWith(".gachipad-validate-") || name === `${basename(source)}.restore`)
        rmSync(join(dataDirectory, name), { recursive: true, force: true });
    }
    const bytes = BigInt(statSync(source).size);
    const space = statfsSync(dataDirectory, { bigint: true });
    const required = bytes + (bytes / 5n > 67108864n ? bytes / 5n : 67108864n);
    if (space.bavail * space.bsize < required)
      throw new Error("SQLite data filesystem has insufficient free space for a snapshot or restore (database size plus 20%, at least 64 MiB extra required)");
    const directory = mkdtempSync(join(dataDirectory, ".gachipad-backup-"));
    const path = join(directory, "snapshot.db");
    const cleanup = () => rmSync(directory, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.once(signal, () => { cleanup(); process.exit(1); });
    try {
      const db = new DatabaseSync(source);
      try { db.exec("PRAGMA busy_timeout=5000"); db.prepare("VACUUM INTO ?").run(path); }
      finally { db.close(); }
      await pipeline(createReadStream(path), process.stdout);
    } finally { cleanup(); }
  ' | gzip -c >"$part" || return 1
  [ -s "$part" ] || { echo "SQLite backup is empty; backup not published" >&2; return 1; }
  gzip -t -- "$part" || { echo "SQLite backup is corrupt; backup not published" >&2; return 1; }
  chmod 600 "$part" && mv "$part" "$file" || return 1
  echo "backup: $file ($(wc -c <"$file" | tr -d ' ') bytes)"
)

postgres_backup() (
  set -euo pipefail
  umask 077
  local dir="$1" part file
  mkdir -p "$dir" || return 1
  part="$(mktemp "$dir/.backup.XXXXXX")" || return 1
  file="$dir/gachipad-$(date +%Y%m%d-%H%M%S)-${part##*.}.archive.gz"
  trap 'rm -f "$part"' EXIT
  docker compose exec -T postgres sh -c \
    'pg_dump --format=custom --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' |
    gzip -c >"$part" || return 1
  [ -s "$part" ] || { echo "PostgreSQL backup is empty; backup not published" >&2; return 1; }
  gzip -t -- "$part" || { echo "PostgreSQL backup is corrupt; backup not published" >&2; return 1; }
  chmod 600 "$part" && mv "$part" "$file" || return 1
  echo "backup: $file ($(wc -c <"$file" | tr -d ' ') bytes)"
)

sqlite_validate() {
  local bytes
  bytes="$(gzip -dc -- "$1" | wc -c)" || return 1
  gzip -dc -- "$1" | docker compose run --rm --no-deps -T -e GACHIPAD_SQLITE_BYTES="$bytes" --entrypoint node api --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { createWriteStream, mkdtempSync, openSync, readSync, closeSync, rmSync, readdirSync, statfsSync } from "node:fs";
    import { pipeline } from "node:stream/promises";
    import { basename, dirname, join } from "node:path";
    const url = process.env.DATABASE_URL ?? "sqlite:///data/gachipad.db";
    const source = url.startsWith("sqlite:") && !url.startsWith("sqlite://")
      ? url.slice("sqlite:".length) : decodeURIComponent(new URL(url).pathname);
    const dataDirectory = dirname(source);
    for (const name of readdirSync(dataDirectory)) {
      if (name.startsWith(".gachipad-backup-") || name.startsWith(".gachipad-validate-") || name === `${basename(source)}.restore`)
        rmSync(join(dataDirectory, name), { recursive: true, force: true });
    }
    const bytes = BigInt(process.env.GACHIPAD_SQLITE_BYTES);
    const space = statfsSync(dataDirectory, { bigint: true });
    const required = bytes + (bytes / 5n > 67108864n ? bytes / 5n : 67108864n);
    if (space.bavail * space.bsize < required)
      throw new Error("SQLite data filesystem has insufficient free space for a snapshot or restore (database size plus 20%, at least 64 MiB extra required)");
    const directory = mkdtempSync(join(dataDirectory, ".gachipad-validate-"));
    const path = join(directory, "snapshot.db");
    const cleanup = () => rmSync(directory, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.once(signal, () => { cleanup(); process.exit(1); });
    try {
      await pipeline(process.stdin, createWriteStream(path, { mode: 0o600 }));
      const header = Buffer.alloc(16), fd = openSync(path, "r");
      try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
      if (header.toString() !== "SQLite format 3\0")
        throw new Error("Not a SQLite backup");
      const db = new DatabaseSync(path);
      const result = db.prepare("PRAGMA integrity_check").get();
      db.close();
      if (Object.values(result ?? {})[0] !== "ok") throw new Error("SQLite integrity check failed");
    } finally { cleanup(); }
  '
}

sqlite_restore() {
  local bytes
  sqlite_validate "$1" || { echo "SQLite backup validation failed; database unchanged" >&2; return 1; }
  sqlite_backup ./backups >&2 || return 1
  bytes="$(gzip -dc -- "$1" | wc -c)" || return 1
  gzip -dc -- "$1" | docker compose run --rm --no-deps -T -e GACHIPAD_SQLITE_BYTES="$bytes" --entrypoint node api --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    import { createWriteStream, renameSync, rmSync, readdirSync, statfsSync } from "node:fs";
    import { pipeline } from "node:stream/promises";
    const url = process.env.DATABASE_URL ?? "sqlite:///data/gachipad.db";
    const destination = url.startsWith("sqlite:") && !url.startsWith("sqlite://")
      ? url.slice("sqlite:".length) : decodeURIComponent(new URL(url).pathname);
    import { basename, dirname, join } from "node:path";
    const dataDirectory = dirname(destination);
    for (const name of readdirSync(dataDirectory)) {
      if (name.startsWith(".gachipad-backup-") || name.startsWith(".gachipad-validate-") || name === `${basename(destination)}.restore`)
        rmSync(join(dataDirectory, name), { recursive: true, force: true });
    }
    const bytes = BigInt(process.env.GACHIPAD_SQLITE_BYTES);
    const space = statfsSync(dataDirectory, { bigint: true });
    const required = bytes + (bytes / 5n > 67108864n ? bytes / 5n : 67108864n);
    if (space.bavail * space.bsize < required)
      throw new Error("SQLite data filesystem has insufficient free space for a snapshot or restore (database size plus 20%, at least 64 MiB extra required)");
    const path = `${destination}.restore`;
    const cleanup = () => rmSync(path, { force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.once(signal, () => { cleanup(); process.exit(1); });
    try {
      await pipeline(process.stdin, createWriteStream(path, { mode: 0o600 }));
      const db = new DatabaseSync(path);
      const result = db.prepare("PRAGMA integrity_check").get();
      db.close();
      if (Object.values(result ?? {})[0] !== "ok") throw new Error("SQLite integrity check failed");
      rmSync(`${destination}-wal`, { force: true });
      rmSync(`${destination}-shm`, { force: true });
      renameSync(path, destination);
    } finally { cleanup(); }
  '
}

postgres_validate() {
  # Consume the full stream before listing the TOC, which may otherwise close stdin early.
  # shellcheck disable=SC2016 # expanded only inside the database container
  gzip -dc -- "$1" | docker compose exec -T postgres sh -c '
    set -eu
    umask 077
    archive="$(mktemp)"
    trap '\''rm -f "$archive"'\'' EXIT
    cat >"$archive"
    pg_restore --list "$archive" >/dev/null
  '
}

postgres_restore() {
  local safety
  postgres_validate "$1" || { echo "PostgreSQL backup validation failed; database unchanged" >&2; return 1; }
  safety="$(postgres_backup ./backups)" || return 1
  printf '%s\n' "$safety" >&2
  # Restore away from the live DB, then rename both databases in one transaction.
  # Writers are stopped; a failed restore or swap leaves the live database intact.
  # shellcheck disable=SC2016 # expanded only inside the database container
  if ! gzip -dc -- "$1" | docker compose exec -T postgres sh -c '
    set -eu
    stage="gp_restore_$(date +%s)_$$"
    old="gp_previous_$(date +%s)_$$"
    trap '\''dropdb --if-exists --force --maintenance-db=template1 --username="$POSTGRES_USER" -- "$stage" >/dev/null 2>&1 || true'\'' EXIT
    createdb --maintenance-db=template1 --username="$POSTGRES_USER" --owner="$POSTGRES_USER" -- "$stage"
    pg_restore --exit-on-error --no-owner --username="$POSTGRES_USER" --dbname="$stage" --single-transaction
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname=template1 \
      --set=live="$POSTGRES_DB" --set=stage="$stage" --set=old="$old" <<'\''SQL'\''
BEGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'\''live'\'' AND pid <> pg_backend_pid();
ALTER DATABASE :"live" RENAME TO :"old";
ALTER DATABASE :"stage" RENAME TO :"live";
COMMIT;
SQL
    dropdb --force --maintenance-db=template1 --username="$POSTGRES_USER" -- "$old" ||
      echo "PostgreSQL restored; could not remove previous database $old" >&2
  '; then
    echo "PostgreSQL restore failed; live database unchanged; safety $safety" >&2
    return 1
  fi
}

database_backup() {
  case "$(database_kind)" in
    mongodb) mongo_backup "$1" ;;
    postgres) postgres_backup "$1" ;;
    sqlite) sqlite_backup "$1" ;;
    external)
      echo "backup: DATABASE_URL uses an external database; no local backup was made. Back up the external server with its own tools before updates or restores." >&2
      [ "${GACHIPAD_EXTERNAL_BACKUP_CONFIRMED:-$(env_get GACHIPAD_EXTERNAL_BACKUP_CONFIRMED)}" = 1 ]
      ;;
  esac
}

database_validate() {
  case "$(database_kind)" in
    mongodb) mongo_transfer validate <"$1" ;;
    postgres) postgres_validate "$1" ;;
    sqlite) sqlite_validate "$1" ;;
    external) die "external databases cannot be restored from a local gachipad backup; use the external server's restore tools" ;;
  esac
}

database_restore() {
  case "$(database_kind)" in
    mongodb) mongo_restore "$1" ;;
    postgres) postgres_restore "$1" ;;
    sqlite) sqlite_restore "$1" ;;
    external) die "external databases cannot be restored from a local gachipad backup; use the external server's restore tools" ;;
  esac
}

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
