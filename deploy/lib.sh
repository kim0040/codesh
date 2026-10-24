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

# wait_healthy [seconds]: waits until Caddy answers /healthz (api and Valkey are behind it)
wait_healthy() {
  local port url deadline
  port="$(env_get HTTP_PORT 80)"
  url="http://127.0.0.1:${port}/healthz"
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
