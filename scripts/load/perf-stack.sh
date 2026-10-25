#!/usr/bin/env bash
# A throwaway production stack (deploy/docker-compose.yml) for load tests, next to any other stack
# on the same host: its own compose project, env file, image tag, port and subnet.
#
#   scripts/load/perf-stack.sh up              # build and start, wait for health
#   scripts/load/perf-stack.sh down            # stop and delete its containers and volumes
#   scripts/load/perf-stack.sh restart-collab  # what --storm restart runs
#
# Defaults: project gachipad-perf, env dir /tmp/gachipad-perf, http://localhost:8850. Override with
# PERF_PROJECT, PERF_DIR, PERF_HTTP_PORT, PERF_SUBNET. Rate limits and quotas are raised because
# every simulated client comes from this one host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${PERF_PROJECT:-gachipad-perf}"
DIR="${PERF_DIR:-/tmp/gachipad-perf}"
HTTP_PORT="${PERF_HTTP_PORT:-8850}"
SUBNET="${PERF_SUBNET:-172.29.150.0/24}"
ENV_FILE="$DIR/.env"
# Extra collab environment for a tuning run, e.g. PERF_COLLAB_ENV="COLLAB_BROADCAST_WINDOW_MS=50".
OVERRIDE="$DIR/override.yml"
compose() {
  local files=(-f "$ROOT/deploy/docker-compose.yml")
  [ -f "$OVERRIDE" ] && files+=(-f "$OVERRIDE")
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${files[@]}" "$@"
}

# Sets NAME=VALUE in the env file, replacing an existing line.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

case "${1:-}" in
  up)
    mkdir -p "$DIR"
    if [ ! -f "$ENV_FILE" ]; then
      (umask 077 && cp "$ROOT/deploy/.env.example" "$ENV_FILE")
      "$ROOT/deploy/generate-secrets.sh" "$ENV_FILE" >/dev/null
    fi
    set_env CODESH_VERSION "$PROJECT"
    set_env HTTP_PORT "$HTTP_PORT"
    set_env HTTPS_PORT "$((HTTP_PORT + 1))"
    set_env NETWORK_SUBNET "$SUBNET"
    for name in RATE_LIMIT_API_PER_MIN RATE_LIMIT_CODE_PER_MIN RATE_LIMIT_CREATE_PER_MIN \
      QUOTA_SHARES_PER_CLIENT QUOTA_SHARES_PER_IP; do
      set_env "$name" 1000000
    done
    rm -f "$OVERRIDE"
    if [ -n "${PERF_COLLAB_ENV:-}" ]; then
      {
        printf 'services:\n  collab:\n    environment:\n'
        for pair in $PERF_COLLAB_ENV; do printf '      %s: "%s"\n' "${pair%%=*}" "${pair#*=}"; done
      } >"$OVERRIDE"
    fi
    compose up -d --build --wait
    # Each rebuild leaves the previous images of this project untagged; the disk may be small.
    docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" >/dev/null
    echo "perf stack $PROJECT up on http://localhost:$HTTP_PORT (env $ENV_FILE)"
    ;;
  down)
    compose down -v --remove-orphans --rmi local
    rm -rf "$DIR"
    ;;
  restart-collab)
    compose restart collab
    ;;
  *)
    echo "usage: $0 up|down|restart-collab" >&2
    exit 2
    ;;
esac
