#!/usr/bin/env bash
# Installer regression checks; no Docker service, DNS, ACME or internet connection required.
set -Eeuo pipefail
trap 'echo "FAIL: network regression at line $LINENO" >&2' ERR
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/install/tls"
cp "$ROOT"/{install.sh,lib.sh,generate-secrets.sh,.env.example} "$WORK/install/"
printf '1.1.0\n' >"$WORK/install/VERSION"
printf 'images\n' >"$WORK/install/images.tar"
(cd "$WORK/install" && sha256sum images.tar VERSION >SHA256SUMS)
cat >"$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$1 ${2:-}" in
  'info --format') case "$*" in *OperatingSystem*) echo Debian ;; *) echo linux ;; esac ;;
  'context inspect') echo unix:///var/run/docker.sock ;;
  'volume inspect') exit 1 ;;
  'compose up')
    if [ -n "${FAIL_START:-}" ] && [ ! -f "$DOCKER_CALLS.failed" ]; then touch "$DOCKER_CALLS.failed"; exit 1; fi ;;
  'compose --profile')
    case "$*" in *' stop '*) [ -z "${FAIL_MDNS_STOP:-}" ] || exit 1 ;; esac ;;
  'compose exec') [ -z "${FAIL_HEALTH:-}" ] || exit 1 ;;
esac
DOCKER
cat >"$WORK/bin/uname" <<'UNAME'
#!/usr/bin/env bash
echo Linux
UNAME
cat >"$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '200'
CURL
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" DOCKER_CALLS="$WORK/calls"
unset GACHIPAD_NETWORK PUBLIC_URL SITE_ADDRESS ACME_EMAIL GACHIPAD_MDNS COMPOSE_PROFILES GACHIPAD_DB DATABASE_URL
cd "$WORK/install"
. ./lib.sh
run() { ./install.sh --db sqlite "$@" </dev/null >"$WORK/log" 2>&1 || { cat "$WORK/log"; return 1; }; }
fresh() { rm -f .env state/database-kind "$DOCKER_CALLS.failed"; : >"$DOCKER_CALLS"; run "$@"; }
refuse() {
  : >"$DOCKER_CALLS"
  if ./install.sh --db sqlite "$@" </dev/null >"$WORK/log" 2>&1; then echo 'invalid public setup accepted'; exit 1; fi
  if grep -Eq '^load |^compose up ' "$DOCKER_CALLS"; then echo 'started before public validation'; exit 1; fi
}
fresh --no-mdns
[ "$(env_get GACHIPAD_NETWORK)" = internal ]
[ "$(env_get SITE_ADDRESS)" = :80 ]
[ "$(env_get RATE_LIMIT_API_PER_MIN)" = 1200 ]
[ "$(env_get ADMIN_ALLOW_CIDR)" = '' ]
grep -q 'network internal' "$WORK/log"
# A legacy env without the mode retains its original settings on reinstall.
sed '/^GACHIPAD_NETWORK=/d' .env >.env.next && mv .env.next .env
PUBLIC_URL=http://old.local SITE_ADDRESS=:80 run --no-mdns
[ "$(env_get GACHIPAD_NETWORK)" = internal ]
[ "$(env_get PUBLIC_URL)" = http://old.local ]
# Fresh public defaults are visible settings, with no active mDNS even if requested.
fresh --network public --domain Share.Example.org --acme-email ops@example.org --mdns
[ "$(env_get GACHIPAD_NETWORK)" = public ]
[ "$(env_get PUBLIC_URL)" = https://share.example.org ]
[ "$(env_get SITE_ADDRESS)" = share.example.org ]
[ "$(env_get ACME_EMAIL)" = ops@example.org ]
[ "$(env_get COMPOSE_PROFILES)" = '' ]
if (select_mdns 1) >"$WORK/mdns.log" 2>&1; then echo 'public mDNS control accepted'; exit 1; fi
[ "$(env_get RATE_LIMIT_API_PER_MIN)" = 300 ]
[ "$(env_get RATE_LIMIT_CODE_GLOBAL_FAILURES_PER_MIN)" = 60 ]
[ "$(env_get UPLOAD_STORAGE_MAX_BYTES)" = 2147483648 ]
[ "$(env_get SSE_MAX_PER_IP)" = 50 ]
[ -n "$(env_get ADMIN_ALLOW_CIDR)" ]
grep -q 'first certificate may take a minute' "$WORK/log"
grep -q 'point DNS A/AAAA' "$WORK/log"
grep -q 'ignores all tls/\*.caddy' "$WORK/log"
if grep -q -- '--probe' "$DOCKER_CALLS"; then echo 'public mDNS probe'; exit 1; fi
# Explicit environment chooses a fresh install, but an existing file wins over environment.
GACHIPAD_NETWORK=internal run
[ "$(env_get GACHIPAD_NETWORK)" = public ]
env_set RATE_LIMIT_API_PER_MIN 123
run
[ "$(env_get RATE_LIMIT_API_PER_MIN)" = 123 ]
# Invalid public settings fail before loading images or rewriting .env.
cp .env "$WORK/saved"
for domain in 127.0.0.1 192.168.1.1 '[::1]' gachipad.local GACHIPAD.LOCAL localhost one-label x..org '-x.org' 'x-.org' 'x.org/path' 'x.org:443' "x.org\$BAD"; do
  refuse --network public --domain "$domain"
  cmp .env "$WORK/saved"
done
refuse --network other
for proxy in '0.0.0.0/0' '::/0' '10.0.0.0/33' '999.0.0.1/24' '::/129' '1:::2/64' '10.0.0.1' 'abc/24'; do
  refuse --network public --behind-proxy "$proxy"
done
refuse --network public --acme-email 'bad email'
# PUBLIC_URL is also accepted; HTTP/non-origin values are not.
rm -f .env state/database-kind
for url in '' http://share.example.org https://127.0.0.1 https://share.example.org/path https://share.example.org:443; do
  PUBLIC_URL="$url" refuse --network public
  [ ! -f .env ]
done
GACHIPAD_NETWORK=public PUBLIC_URL=https://share.example.org fresh --no-mdns
[ "$(env_get SITE_ADDRESS)" = share.example.org ]
# Proxy termination uses HTTP ingress and trusts only the nominated CIDR plus the app network.
HTTP_PORT=18480 HTTPS_PORT=18443 fresh --network public --domain share.example.org --behind-proxy 192.0.2.7/32
[ "$(env_get SITE_ADDRESS)" = http://share.example.org ]
[ "$(env_get CADDY_TRUSTED_PROXIES)" = 192.0.2.7/32 ]
[ "$(env_get TRUST_PROXY)" = 172.29.88.0/24,192.0.2.7/32 ]
grep -q 'nonstandard host ports' "$WORK/log"
run
[ "$(env_get GACHIPAD_BEHIND_PROXY)" = 192.0.2.7/32 ]
fresh --network public --domain share.example.org --behind-proxy 2001:db8::1/128
[ "$(env_get CADDY_TRUSTED_PROXIES)" = 2001:db8::1/128 ]
# Mode switches preserve the old internal site and disable mDNS before public ingress starts.
fresh --mdns
[ "$(env_get COMPOSE_PROFILES)" = mdns ]
env_set PUBLIC_URL http://private.local
env_set SITE_ADDRESS :80
printf 'tls internal\n' >tls/local.caddy
run --network public --domain share.example.org
[ "$(env_get COMPOSE_PROFILES)" = '' ]
grep -q '^compose --profile mdns stop mdns' "$DOCKER_CALLS"
[ "$(env_get GACHIPAD_INTERNAL_PUBLIC_URL)" = http://private.local ]
[ "$(env_get RATE_LIMIT_API_PER_MIN)" = 1200 ] # existing operator limits stay
run --network internal --no-mdns
[ "$(env_get PUBLIC_URL)" = http://private.local ]
[ "$(env_get SITE_ADDRESS)" = :80 ]
# A failed start restores the exact previous env and attempts to restart it, under the same lock.
cp .env "$WORK/saved"
if FAIL_START=1 run --network public --domain share.example.org; then echo 'failed start accepted'; exit 1; fi
cmp .env "$WORK/saved"
[ ! -d state/install.lock.d ]
[ "$(find . -maxdepth 1 -name '.env.install-snapshot.*' | wc -l)" -eq 0 ]
rm -f "$DOCKER_CALLS.failed"
run --network public --domain share.example.org
cp .env "$WORK/public-saved"
if FAIL_START=1 run --network internal --no-mdns; then echo 'failed internal switch accepted'; exit 1; fi
cmp .env "$WORK/public-saved"
# Failure to stop an existing advertiser must abort a public switch and restore configuration.
run --network internal --mdns
cp .env "$WORK/saved"
if FAIL_MDNS_STOP=1 run --network public --domain share.example.org; then echo 'mDNS failure ignored'; exit 1; fi
cmp .env "$WORK/saved"
# Fresh interactive setup asks exactly once and accepts the default; flags/env skip it.
python3 - <<'PY'
import os, pty, select, subprocess, time
for setting, flag, prompt in [(None, [], True), ('internal', [], False), (None, ['--network', 'internal'], False)]:
    os.unlink('.env')
    env = os.environ.copy()
    if setting is not None: env['GACHIPAD_NETWORK'] = setting
    master, slave = pty.openpty()
    p = subprocess.Popen(['./install.sh', '--db', 'sqlite', '--no-mdns', *flag], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b''
    sent = False
    deadline = time.monotonic() + 20
    while p.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try: output += os.read(master, 65536)
            except OSError: break
            if b'Network [internal/public]' in output and not sent:
                os.write(master, b'\n'); sent = True
    if p.poll() is None: p.kill()
    assert p.wait() == 0, output.decode()
    os.close(master)
    assert output.count(b'Network [internal/public]') == int(prompt), output.decode()
    assert 'GACHIPAD_NETWORK=internal' in open('.env').read()
PY
echo 'network tests passed (default, public, invalid input, proxy, legacy, persistence, switches, rollback, mDNS, interactive)'
