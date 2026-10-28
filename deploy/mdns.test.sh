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
  'info --format') printf '%s\n' "${FAKE_DOCKER_OS:-linux}" ;;
  'volume inspect') exit 1 ;;
  'run --rm')
    case "$*" in
      *--addresses*) echo 192.0.2.20 ;;
      *--probe*)
        case "${PROBE_MODE:-free}" in
          fail) exit 2 ;; timeout) exit 124 ;; all) exit 10 ;;
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
cat >"$WORK/bin/hostname" <<'HOSTNAME'
#!/usr/bin/env bash
echo 192.0.2.20
HOSTNAME
cat >"$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf 200
CURL
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" DOCKER_CALLS="$WORK/calls"
unset GACHIPAD_MDNS COMPOSE_PROFILES MDNS_HOSTNAME GACHIPAD_DB DATABASE_URL
cd "$WORK/install"
run_install() {
  rm -f .env state/database-kind
  : >"$DOCKER_CALLS"
  ./install.sh --db sqlite "$@" >"$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; return 1; }
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
  [ "$(grep -c -- '--probe' "$DOCKER_CALLS")" -le 10 ]
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
grep -q '^compose --profile mdns up -d --no-deps --force-recreate mdns$' "$DOCKER_CALLS"
./mdns.sh status >"$WORK/status.log"
grep -q 'enabled' "$WORK/status.log"
./mdns.sh disable >"$WORK/control.log" 2>&1
assert_profile postgres,custom
grep -q '^compose --profile mdns stop mdns$' "$DOCKER_CALLS"
# The existing install-wide lock rejects concurrent changes.
(install_lock; env -u GACHIPAD_LOCK_PATH -u GACHIPAD_LOCK_PID ./mdns.sh disable 9>&- >"$WORK/locked.log" 2>&1 && exit 1; install_unlock)
grep -q 'another update' "$WORK/locked.log"
[ ! -d state/install.lock.d ]
echo 'PASS: mdns flags/env, TTY prompt, Linux guard, conflict renaming, bounded failures, profiles, control and lock'
