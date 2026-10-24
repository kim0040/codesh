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

# wait_healthy [seconds] [path]: waits until Caddy answers /healthz (api and Valkey are behind it),
# or another path such as /readyz (api can also read MongoDB)
wait_healthy() {
  local port url deadline
  port="$(env_get HTTP_PORT 80)"
  url="http://127.0.0.1:${port}${2:-/healthz}"
  deadline=$((SECONDS + ${1:-120}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    else
      wget -q -O /dev/null "$url" 2>/dev/null && return 0
    fi
    sleep 2
  done
  echo "no healthy answer from $url within ${1:-120}s; recent logs:" >&2
  docker compose logs --tail 20 >&2 || true
  return 1
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
      restore) mongorestore "$@" --drop --nsInclude "codesh.*" ;;
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
  [ -f "$1.sha256" ] || die "missing checksum: $1.sha256"
  local expected
  expected="$(awk 'NR == 1 {print $1}' "$1.sha256")"
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
