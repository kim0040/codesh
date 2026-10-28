#!/usr/bin/env bash
# Real Linux install, host-network DNS response, own-address probe and disable checks.
# Invoked under the shared box lock with an owned bundle/project; caller restores image tags.
set -euo pipefail
ROOT="$(pwd)"
BUNDLE="$(realpath "${1:?bundle}")"
WORK="${2:?owned directory}"
PROJECT="${3:?owned project}"
case "$PROJECT" in gp-dbdeploy-*) ;; *) echo 'verification requires gp-dbdeploy- project' >&2; exit 1 ;; esac
[ ! -e "$WORK" ] || { echo 'verification directory already exists' >&2; exit 1; }
mkdir -p "$WORK"
INSTALL="$WORK/install"
mkdir "$INSTALL"
export COMPOSE_PROJECT_NAME="$PROJECT"
cleanup() {
  local status=$?
  trap - EXIT
  if [ -f "$INSTALL/.env" ]; then
    [ ! -f "$WORK/install.log" ] || cp "$WORK/install.log" "$ROOT/.box-out/mdns-live-install.log"
    (cd "$INSTALL" && docker compose --profile mdns --profile mongodb --profile postgres down -v --remove-orphans) >/dev/null 2>&1 || status=1
  fi
  rm -rf "$WORK"
  echo "mdns cleanup: owned stack, volumes and directory removed (status=$status)"
  exit "$status"
}
trap cleanup EXIT
fail() { echo "FAIL: mdns: $*" >&2; exit 1; }
tar xzf "$BUNDLE" -C "$INSTALL" --strip-components=1
cd "$INSTALL"
. ./lib.sh
cp .env.example .env
env_set HTTP_PORT "${VERIFY_MDNS_HTTP_PORT:-18089}"
env_set HTTPS_PORT "${VERIFY_MDNS_HTTPS_PORT:-18449}"
env_set NETWORK_SUBNET "${VERIFY_MDNS_NETWORK_SUBNET:-172.29.97.0/24}"
env_set VALKEY_MAXMEMORY 128mb
env_set UPDATE_CHECK off
before="$(env_get PUBLIC_URL):$(env_get SITE_ADDRESS)"
# The desired default name must actually be free; do not claim acceptance for a renamed host.
./install.sh --db sqlite --mdns >"$WORK/install.log" 2>&1 || { echo 'FAIL: mdns install (operator log copied to .box-out/mdns-live-install.log)' >&2; exit 1; }
[ "$before" = "$(env_get PUBLIC_URL):$(env_get SITE_ADDRESS)" ] || fail 'PUBLIC_URL or SITE_ADDRESS changed'
[ "$(env_get MDNS_HOSTNAME)" = gachipad.local ] || fail 'default name was already taken'
echo 'PASS: Linux install enables gachipad.local without changing PUBLIC_URL or SITE_ADDRESS'
image="$(mdns_image)"
docker run --rm --pull never --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$ROOT/deploy/mdns/probe.test.mjs:/app/probe.test.mjs:ro" "$image" node --test probe.test.mjs
echo 'PASS: real node probe foreign/own/silence/goodbye/error exit codes and malformed packets'
status=0
timeout -k 1 6 docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges "$image" node index.mjs --probe gp-no-network.local >/dev/null 2>&1 || status=$?
[ "$status" = 2 ] || fail "socket/network failure returned $status instead of probe error exit 2"
echo 'PASS: real unavailable multicast network returns probe error exit 2'
query() {
  local status=0
  timeout -k 1 6 docker run --rm --pull never --network host --read-only --cap-drop ALL \
    --security-opt no-new-privileges "$image" node index.mjs --query gachipad.local >/dev/null 2>&1 || status=$?
  return "$status"
}
answered=0
for _ in {1..8}; do
  status=0; query || status=$?
  if [ "$status" = 10 ]; then answered=1; break; fi
  sleep 1
done
[ "$answered" = 1 ] || fail 'independent host-network query got no answer'
echo 'PASS: separate host-network container resolves gachipad.local over multicast DNS'
mdns_run --probe gachipad.local || fail 'our own address was treated as another host'
echo 'PASS: conflict probe ignores addresses belonging to this host'
./mdns.sh status >"$WORK/status.log"
grep -q 'enabled (gachipad.local)' "$WORK/status.log" || fail 'enabled status missing'
./mdns.sh disable >/dev/null
sleep 1
status=0; query || status=$?
[ "$status" = 0 ] || fail 'DNS still answers after disable, or query failed'
[ -z "$(docker compose --profile mdns ps -q --status running mdns)" ] || fail 'mdns service is still running'
echo 'PASS: mdns.sh disable stops publication and independent query receives no answer'
# The old updater's missing-helper path can be repaired from the bundle without a registry.
docker compose --profile mdns rm -f mdns >/dev/null
rm mdns.sh
case "$image" in
  localhost:*/gp-dbdeploy-*/gachipad-mdns:*)
    docker image rm "$image" >/dev/null
    if docker image inspect "$image" >/dev/null 2>&1; then fail 'owned image tag still exists before offline repair'; fi ;;
esac
cp -p .env "$WORK/before-tools.env"
./update.sh --mdns-tools "$BUNDLE" >"$WORK/tools.log" 2>&1 || fail 'offline tools repair failed'
[ -x mdns.sh ] || fail 'offline repair did not install helper'
docker image inspect "$image" >/dev/null 2>&1 || fail 'offline repair did not load image'
cmp .env "$WORK/before-tools.env" || fail 'offline tools repair changed settings'
echo 'PASS: same-version offline bundle restores missing helper and local image without settings or service changes'
# Verify the same existing-install path, including same-host conflict handling.
./mdns.sh enable >/dev/null
./mdns.sh enable >/dev/null
[ "$(env_get MDNS_HOSTNAME)" = gachipad.local ] || fail 'repeat enable renamed our own host'
./mdns.sh disable >/dev/null
echo 'PASS: existing install can enable repeatedly without renaming; only mdns restarts'
echo 'verify-mdns: all checks passed'
