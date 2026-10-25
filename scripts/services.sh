#!/usr/bin/env bash
# Keep a source checkout's existing dev databases when its default Compose project is renamed.
set -euo pipefail
cd "$(dirname "$0")/.."
# legacy codesh name (1.0.x); remove in 2.0
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] &&
  ! docker volume inspect gachipad-dev_mongo-data >/dev/null 2>&1 &&
  docker volume inspect codesh-dev_mongo-data >/dev/null 2>&1; then
  export COMPOSE_PROJECT_NAME=codesh-dev
  echo 'warning: reusing the legacy development project to preserve its databases' >&2
fi
docker compose -f deploy/docker-compose.dev.yml "$@"
