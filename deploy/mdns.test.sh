#!/usr/bin/env bash
# Installer/control regression checks with a bounded, stubbed network probe.
set -Eeuo pipefail
trap 'echo "FAIL: mdns regression at line $LINENO callers ${BASH_LINENO[*]}" >&2' ERR
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/install"
cp "$ROOT"/{install.sh,lib.sh,generate-secrets.sh,mdns.sh,.env.example} "$WORK/install/"
printf '1.1.0\n' >"$WORK/install/VERSION"
printf 'images\n' >"$WORK/install/images.tar"
(cd "$WORK/install" && sha256sum images.tar VERSION >SHA256SUMS)
cat >"$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$1 ${2:-}" in
  'info --format')
    case "$*" in
      *OperatingSystem*) echo "${FAKE_DOCKER_SYSTEM:-Debian}" ;;
      *) echo "${FAKE_DOCKER_OS:-linux}" ;;
    esac ;;
  'context inspect') echo "${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}" ;;
  'image inspect') [ -z "${FAKE_MISSING_IMAGE:-}" ] || [ -f "$DOCKER_CALLS.loaded" ] || exit 1 ;;
  'load -i') touch "$DOCKER_CALLS.loaded" ;;
  'compose --profile')
    case "$*" in
      *' pull '*) [ -z "${FAKE_PULL_FAIL:-}" ] || exit 1; touch "$DOCKER_CALLS.loaded" ;;
      *' up '*)
        [ -z "${FAKE_UP_FAIL:-}" ] || exit 1
        [ -z "${FAKE_UP_SIGNAL:-}" ] || kill -TERM "$PPID" ;;
      *' stop '*) [ -z "${FAKE_STOP_FAIL:-}" ] || exit 1 ;;
    esac ;;
  'volume inspect') exit 1 ;;
  'run --rm')
    case "$*" in
      *--addresses*) echo 192.0.2.20 ;;
      *--probe*)
        case "${PROBE_MODE:-free}" in
          fail) exit 2 ;; timeout) exit 124 ;; hang) sleep 30 ;; all) exit 10 ;;
          conflict) case "${*: -1}" in gachipad.local | gachipad-2.local) exit 10 ;; esac ;;
        esac
        ;;
    esac ;;
esac
DOCKER
cat >"$WORK/bin/uname" <<'UNAME'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_OS:-Linux}"
UNAME
cat >"$WORK/bin/ip" <<'IP'
#!/usr/bin/env bash
printf '%s\n' '2: eth0 inet 192.0.2.20/24 scope global eth0' '3: docker0 inet 172.17.0.1/16 scope global docker0' '4: br-test inet 172.29.1.1/24 scope global br-test' '5: veth0 inet 172.20.0.1/24 scope global veth0' '6: virbr0 inet 192.168.122.1/24 scope global virbr0'
IP
cat >"$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf 200
CURL
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" DOCKER_CALLS="$WORK/calls"
unset GACHIPAD_MDNS COMPOSE_PROFILES MDNS_HOSTNAME GACHIPAD_DB DATABASE_URL DOCKER_HOST DOCKER_CONTEXT
cd "$WORK/install"
run_install() {
  rm -f .env state/database-kind
  : >"$DOCKER_CALLS"
  ./install.sh --db sqlite "$@" </dev/null >"$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; return 1; }
}
assert_profile() { grep -qx "COMPOSE_PROFILES=$1" .env; }
run_install
assert_profile mdns
grep -q 'http://gachipad.local' "$WORK/install.log"
grep -q 'http://192.0.2.20' "$WORK/install.log"
grep -q 'Android' "$WORK/install.log"
run_install --no-mdns
assert_profile ''
GACHIPAD_MDNS=0 run_install
assert_profile ''
GACHIPAD_MDNS=0 run_install --mdns
assert_profile mdns
GACHIPAD_MDNS=1 run_install --no-mdns
assert_profile ''
GACHIPAD_MDNS=1 run_install
assert_profile mdns
FAKE_OS=Darwin run_install --mdns
assert_profile ''
grep -q 'native Linux Docker host' "$WORK/install.log"
FAKE_DOCKER_OS=windows run_install --mdns
assert_profile ''
if grep -q -- '--probe' "$DOCKER_CALLS"; then echo 'probed non-Linux host' >&2; exit 1; fi
PROBE_MODE=conflict run_install --mdns
assert_profile mdns
grep -qx 'MDNS_HOSTNAME=gachipad-3.local' .env
grep -q 'in use; using gachipad-3.local' "$WORK/install.log"
for mode in fail timeout all; do
  PROBE_MODE="$mode" run_install --mdns
  assert_profile mdns
  grep -qx 'MDNS_HOSTNAME=gachipad.local' .env
  grep -q 'keeping gachipad.local' "$WORK/install.log"
  expected=1; [ "$mode" != all ] || expected=10
  [ "$(grep -c -- '--probe' "$DOCKER_CALLS")" -eq "$expected" ]
done
MDNS_HOSTNAME=custom.local run_install --mdns
grep -qx 'MDNS_HOSTNAME=custom.local' .env
COMPOSE_PROFILES=postgres,mdns run_install --no-mdns
assert_profile '' # generator removes the unselected DB profile, and selection removes mdns
COMPOSE_PROFILES=custom run_install --mdns
assert_profile custom,mdns
# A real pseudoterminal verifies one default-yes prompt, decline, and prompt-free flags/env.
python3 - "$WORK/install.log" <<'PY'
import os, pty, select, subprocess, sys, time
for answer, flag, setting, expected in [(b'\n', [], None, True), (b'n\n', [], None, False),
                                      (b'', ['--mdns'], '0', True), (b'', [], '1', True),
                                      (b'', ['--no-mdns'], None, False)]:
    os.unlink('.env')
    env = os.environ.copy()
    if setting is not None: env['GACHIPAD_MDNS'] = setting
    master, slave = pty.openpty()
    process = subprocess.Popen(['./install.sh', '--db', 'sqlite', *flag], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b''
    deadline = time.monotonic() + 20
    sent = False
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: break
            output += chunk
            if b'[Y/n]:' in output and not sent:
                os.write(master, answer); sent = True
    if process.poll() is None: process.kill()
    assert process.wait() == 0, output.decode()
    os.close(master)
    prompt = not flag and setting != '1'
    assert output.count(b'[Y/n]:') == int(prompt), output.decode()
    assert b'.local' in output or not prompt
    profiles = [line for line in open('.env') if line.startswith('COMPOSE_PROFILES=')][-1]
    assert ('mdns' in profiles) == expected, profiles
PY
# Existing installs keep app settings and only touch the mdns service.
. ./lib.sh
env_set COMPOSE_PROFILES postgres,custom
env_set PUBLIC_URL http://localhost
env_set SITE_ADDRESS :80
before="$(env_get PUBLIC_URL):$(env_get SITE_ADDRESS)"
: >"$DOCKER_CALLS"
./mdns.sh enable >"$WORK/control.log" 2>&1
assert_profile postgres,custom,mdns
[ "$before" = "$(env_get PUBLIC_URL):$(env_get SITE_ADDRESS)" ]
grep -q '^compose --profile mdns up -d --wait --wait-timeout 15 --pull never --no-deps --force-recreate mdns$' "$DOCKER_CALLS"
./mdns.sh status >"$WORK/status.log"
grep -q 'enabled' "$WORK/status.log"
./mdns.sh disable >"$WORK/control.log" 2>&1
assert_profile postgres,custom
grep -q '^compose --profile mdns stop mdns$' "$DOCKER_CALLS"
# The existing install-wide lock rejects concurrent changes.
(install_lock; env -u GACHIPAD_LOCK_PATH -u GACHIPAD_LOCK_PID ./mdns.sh disable 9>&- >"$WORK/locked.log" 2>&1 && exit 1; install_unlock)
grep -q 'another update' "$WORK/locked.log"
[ ! -d state/install.lock.d ]
# Read-only status remains available while the mutation lock is held.
(install_lock; env -u GACHIPAD_LOCK_PATH -u GACHIPAD_LOCK_PID ./mdns.sh status 9>&- >"$WORK/locked-status.log"; install_unlock)
# An existing install keeps both enabled and disabled choices without a probe or prompt.
for flag in --no-mdns --mdns; do
  run_install "$flag"
  env_set MDNS_HOSTNAME deliberate-2.local
  cp .env "$WORK/rerun.env"
  : >"$DOCKER_CALLS"
  ./install.sh --db sqlite </dev/null >"$WORK/rerun.log" 2>&1
  cmp .env "$WORK/rerun.env"
  if grep -q -- '--probe' "$DOCKER_CALLS"; then exit 1; fi
  if grep -q '\[Y/n\]' "$WORK/rerun.log"; then exit 1; fi
done
# Reject invalid policy before any Docker load or secret generation.
: >"$DOCKER_CALLS"
if GACHIPAD_MDNS=2 ./install.sh </dev/null >"$WORK/invalid.log" 2>&1; then exit 1; fi
if grep -q '^load ' "$DOCKER_CALLS"; then exit 1; fi
for setting in desktop remote context; do
  case "$setting" in
    desktop) FAKE_DOCKER_SYSTEM='Docker Desktop' run_install --mdns ;;
    remote) DOCKER_HOST=ssh://remote run_install --mdns ;;
    context) FAKE_DOCKER_ENDPOINT=tcp://remote:2375 run_install --mdns ;;
  esac
  assert_profile ''
  if grep -q -- '--probe' "$DOCKER_CALLS"; then exit 1; fi
done
# A genuinely hung Docker invocation is killed by the wrapper and removed explicitly.
start=$SECONDS
PROBE_MODE=hang run_install --mdns
[ "$((SECONDS - start))" -lt 11 ]
grep -q '^rm -f gachipad-mdns-probe-' "$DOCKER_CALLS"
grep -q -- 'run --rm --pull never --name .* --network host --read-only --cap-drop ALL --security-opt no-new-privileges' "$DOCKER_CALLS"
# Optional aliases are checked too, with a warning rather than silent renaming.
env_set MDNS_ALIASES gachipad-2.local
PROBE_MODE=conflict ./mdns.sh enable >"$WORK/aliases.log" 2>&1
grep -q 'alias gachipad-2.local is in use' "$WORK/aliases.log"
env_set MDNS_ALIASES ''
./mdns.sh disable >/dev/null
# Missing image + unavailable registry must fail before persisting anything.
cp .env "$WORK/original.env"
rm -f "$DOCKER_CALLS.loaded"
: >"$DOCKER_CALLS"
if FAKE_MISSING_IMAGE=1 FAKE_PULL_FAIL=1 ./mdns.sh enable >"$WORK/image.log" 2>&1; then exit 1; fi
cmp .env "$WORK/original.env"
grep -q 'cannot probe or enable' "$WORK/image.log"
if grep -q -- '--probe' "$DOCKER_CALLS"; then exit 1; fi
FAKE_MISSING_IMAGE=1 ./mdns.sh enable >/dev/null 2>&1
./mdns.sh disable >/dev/null
cp .env "$WORK/original.env"
if FAKE_UP_FAIL=1 ./mdns.sh enable >"$WORK/up.log" 2>&1; then exit 1; fi
cmp .env "$WORK/original.env"
if FAKE_UP_SIGNAL=1 ./mdns.sh enable >"$WORK/signal.log" 2>&1; then exit 1; fi
cmp .env "$WORK/original.env"
[ -z "$(find . -name '.env.mdns-*' -print)" ]
# Named sites and HTTPS do not claim HTTP aliases or literal IPs will work.
for site in example.test http://example.test :80; do
  env_set SITE_ADDRESS "$site"
  public=http://example.test
  [ "$site" != :80 ] || public=https://example.test
  env_set PUBLIC_URL "$public"
  mdns_profile 1
  mdns_addresses >"$WORK/addresses.log"
  if grep -q 'open http://\|server address http://' "$WORK/addresses.log"; then exit 1; fi
  grep -q SITE_ALIASES "$WORK/addresses.log"
  grep -q 'server IP 192.0.2.20' "$WORK/addresses.log"
  if grep -q '172.17.\|172.29.\|172.20.\|192.168.122.' "$WORK/addresses.log"; then exit 1; fi
done
# A failed optional stop on a rerun cannot fail the installation.
FAKE_STOP_FAIL=1 ./install.sh --db sqlite --no-mdns </dev/null >/dev/null 2>&1
# A fresh disabled install never issues a stop.
run_install --no-mdns
if grep -q '^compose --profile mdns stop mdns$' "$DOCKER_CALLS"; then exit 1; fi
echo 'PASS: mdns flags/env, TTY prompt, Linux guard, conflict renaming, bounded failures, profiles, control and lock'
