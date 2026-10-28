#!/usr/bin/env bash
# Real Compose environment regression checks; run on the box under the shared lock.
# Uses the existing Node base image, no database connection and no published host ports.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d /data/workspace/gp-dbdeploy-env.XXXXXX)"
export COMPOSE_PROJECT_NAME="gp-dbdeploy-env-$$"
unset DATABASE_URL GACHIPAD_DB COMPOSE_PROFILES
cp "$ROOT"/{docker-compose.yml,.env.example,lib.sh,generate-secrets.sh} "$WORK/"
cd "$WORK"
cleanup() {
  local status=$?
  trap - EXIT
  docker compose --profile mongodb --profile postgres down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
# shellcheck source=/dev/null
source ./lib.sh
cp .env.example .env
env_set NETWORK_SUBNET 172.29.100.0/24
./generate-secrets.sh >/dev/null
cat >docker-compose.override.yml <<'YML'
services:
  api:
    image: node:22.23.3-slim
  collab:
    image: node:22.23.3-slim
YML
check() {
  local service
  for service in api collab; do
    docker compose run --rm --no-deps -T --pull never --entrypoint node "$service" -e "$1" "${2:-}"
  done
}
check 'if (!process.env.DATABASE_URL.startsWith("sqlite:")) throw new Error("Fresh database default changed")'
echo 'PASS: fresh Compose env selects SQLite in both applications'
sed -i '/^DATABASE_URL=/d; /^GACHIPAD_DATABASE_URL=/d; /^GACHIPAD_DB=/d' .env
check 'if (process.env.DATABASE_URL !== process.env.MONGO_URL) throw new Error("Legacy MongoDB fallback changed")'
echo 'PASS: pre-selection Compose env retains MongoDB in both applications'
url="postgresql://fixture:literal\$TOKEN#password@db.invalid/it's-literal"
env_set DATABASE_URL "$url"
./generate-secrets.sh >/dev/null
expected="$(printf '%s' "$url" | sha256sum | cut -d ' ' -f1)"
check 'if (require("node:crypto").createHash("sha256").update(process.env.DATABASE_URL).digest("hex") !== process.argv[1]) throw new Error("Literal database URL changed")' "$expected"
echo 'PASS: literal external URL reaches both application containers unchanged'
echo 'compose-env.test.sh: all checks passed'
