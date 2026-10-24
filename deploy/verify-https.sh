#!/usr/bin/env bash
# Disposable security stack only; run after verify-security.mjs through scripts/box.
set -euo pipefail
root="$(pwd)"
export COMPOSE_PROJECT_NAME=codesh-security-edge COMPOSE_FILE="$root/deploy/docker-compose.yml" COMPOSE_ENV_FILES="$root/.box-out/security-deploy/.env"
cp "$COMPOSE_ENV_FILES" "$COMPOSE_ENV_FILES.http"
cleanup() {
  mv "$COMPOSE_ENV_FILES.http" "$COMPOSE_ENV_FILES"
  rm -f deploy/tls/security-test.caddy
}
trap cleanup EXIT
cp deploy/tls/internal.caddy.example deploy/tls/security-test.caddy
sed -i -e 's|^SITE_ADDRESS=.*|SITE_ADDRESS=localhost|' -e 's|^PUBLIC_URL=.*|PUBLIC_URL=https://localhost:18443|' "$COMPOSE_ENV_FILES"
docker compose up -d --wait caddy api >/dev/null 2>&1
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .box-out/security-deploy/root.crt >/dev/null
curl --fail --silent --show-error --cacert .box-out/security-deploy/root.crt -D .box-out/security-deploy/https.headers https://localhost:18443/api/session -o /dev/null
grep -Eiq 'set-cookie:.*; secure' .box-out/security-deploy/https.headers
curl --fail --silent --show-error --cacert .box-out/security-deploy/root.crt -D .box-out/security-deploy/hsts.headers https://localhost:18443/ -o /dev/null
grep -Eiq 'strict-transport-security: max-age=31536000' .box-out/security-deploy/hsts.headers
echo 'M6/L1: local-CA HTTPS verified with exported public CA; Secure session cookie and HTTPS-only HSTS present'
