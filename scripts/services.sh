#!/usr/bin/env bash
# Keep a source checkout's existing dev databases when its default Compose project is renamed.
set -euo pipefail
cd "$(dirname "$0")/.."
# legacy codesh name (1.0.x); remove in 2.0
legacy=0
if [ -z "${COMPOSE_PROJECT_NAME:-}" ] &&
  ! docker volume inspect gachipad-dev_mongo-data >/dev/null 2>&1 &&
  docker volume inspect codesh-dev_mongo-data >/dev/null 2>&1; then
  export COMPOSE_PROJECT_NAME=codesh-dev
  legacy=1
  echo 'warning: reusing the legacy development project to preserve its databases' >&2
fi
docker compose -f deploy/docker-compose.dev.yml "$@"
# legacy codesh name (1.0.x); remove in 2.0
# The apps default to the database gachipad, the reused volume holds codesh: copy it once, so a
# checkout does not silently start on an empty database. The old database stays where it is.
if [ "$legacy" = 1 ] && [ "${1:-}" = up ]; then
  # shellcheck disable=SC2016 # expanded by the shell in the container
  docker compose -f deploy/docker-compose.dev.yml exec -T mongo sh -c '
    set -eu
    count() { mongosh --quiet --eval "db.getSiblingDB(\"$1\").getCollectionNames().length"; }
    [ "$(count codesh)" -gt 0 ] && [ "$(count gachipad)" = 0 ] || exit 0
    mongodump --quiet --archive --db codesh |
      mongorestore --quiet --archive --nsFrom "codesh.\$collection\$" --nsTo "gachipad.\$collection\$"
    echo "copied the database codesh to gachipad (codesh is kept)" >&2
  '
fi
