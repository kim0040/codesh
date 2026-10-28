#!/usr/bin/env bash
# Read-only host checks and installer paths, using deterministic command fixtures.
set -Eeuo pipefail
trap 'echo "FAIL: preflight regression at line $LINENO" >&2' ERR
ROOT="$(cd "$(dirname "$0")" && pwd)"
F="$(mktemp -d)"
trap 'rm -rf "$F"' EXIT
mkdir -p "$F/bin" "$F/install/tls" "$F/procnet"
cp "$ROOT"/{install.sh,preflight.sh,lib.sh,generate-secrets.sh,docker-compose.yml,.env.example} "$F/install/"
printf '1.1.0\n' >"$F/install/VERSION"
cat >"$F/bin/fixture" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail
case "${0##*/}" in
  docker)
    printf '%s\n' "$*" >>"$DOCKER_CALLS"
    case "$1 ${2:-}" in
      'version ') echo "${STUB_VERSION:-Docker Engine}" ;;
      'info ')
        case "${STUB_DAEMON:-ok}" in
          denied) echo 'permission denied' >&2; exit 1 ;;
          stopped) echo 'cannot connect' >&2; exit 1 ;;
        esac ;;
      'info --format')
        case "$*" in
          *Architecture*) echo "${STUB_ARCH-amd64}" ;;
          *DockerRootDir*) echo /data ;;
          *SecurityOptions*) echo "${STUB_SECURITY-[]}" ;;
          *OperatingSystem*) echo Debian ;;
          *) echo linux ;;
        esac ;;
      'compose version')
        [ "${STUB_COMPOSE:-ok}" != missing ] || exit 1
        echo "${STUB_COMPOSE_VERSION:-2.20.0}" ;;
      'ps -q')
        # An unrelated project/directory must never be treated as this installation.
        if [ -n "${STUB_OWN_PORTS:-}" ] && [[ "$*" == *"label=com.docker.compose.project.working_dir=$PWD"* ]]; then echo own-caddy; fi ;;
      'inspect --format')
        case "$*" in
          *NetworkSettings.Ports*) printf '%s\n' "${STUB_OWN_PORTS:-}" ;;
          *) echo 'true false 0' ;;
        esac ;;
      'volume inspect') exit 1 ;;
      'compose ps') echo fixture-caddy ;;
      'context inspect') echo unix:///var/run/docker.sock ;;
      'compose --env-file')
        [[ "$*" != *' pull '* ]] || [ "${STUB_PULL:-ok}" = ok ] || exit 1
        # Pull must precede any new credentials file, and must use template version.
        [ ! -e .env ] || [ "${STUB_EXISTING:-0}" = 1 ]
        [ "$GACHIPAD_VERSION" = 1.1.0 ] ;;
    esac ;;
  ss) [ "${STUB_SS_FAIL:-0}" = 0 ] || exit 1; printf '%s\n' "${STUB_LISTENERS:-}" ;;
  netstat) printf '%s\n' "${STUB_NETSTAT:-}" ;;
  systemctl) [ "${STUB_BOOT:-enabled}" = enabled ] ;;
  timedatectl) echo "${STUB_CLOCK:-yes}" ;;
  stat) echo "${STUB_FS-ext2/ext3}" ;;
  findmnt) echo "${STUB_MOUNT-rw,relatime}" ;;
  df)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
    if [ "${*: -1}" = . ]; then free="${STUB_FOLDER_FREE:-99999999}"; else free="${STUB_DOCKER_FREE:-99999999}"; fi
    printf 'fixture 100000000 1 %s 1%% /data\n' "$free" ;;
  sysctl) echo "${STUB_UNPRIVILEGED:-1024}" ;;
  getenforce) echo "${STUB_SELINUX:-Disabled}" ;;
  ufw) echo "Status: ${STUB_UFW:-inactive}" ;;
  firewall-cmd) [ "${STUB_FIREWALLD:-off}" = on ] ;;
  nft) [ "${STUB_NFT:-ok}" != denied ] || exit 1; printf '%s\n' "${STUB_RULES:-}" ;;
  ip) echo '192.0.2.0/24 dev eth0 scope link src 192.0.2.20' ;;
  curl) printf 200 ;;
esac
FIXTURE
chmod +x "$F/bin/fixture"
for tool in docker ss netstat systemctl timedatectl stat findmnt df sysctl getenforce ufw firewall-cmd nft ip curl; do ln -s fixture "$F/bin/$tool"; done
export PATH="$F/bin:$PATH" DOCKER_CALLS="$F/docker.calls"
cd "$F/install"
# shellcheck source=lib.sh
. ./lib.sh
# shellcheck source=preflight.sh
. ./preflight.sh
# Hide selected tools without depending on what happens to be installed on the test host.
command() {
  if [ "${1:-}" = -v ] && [[ ",${HIDE:-}," == *",${2:-},"* ]]; then return 1; fi
  builtin command "$@"
}
COUNT=0
expect() {
  local expected="$1" pattern="$2" result=0
  shift 2
  "$@" >"$F/result" 2>&1 || result=$?
  if [ "$result" != "$expected" ] || ! grep -qF -- "$pattern" "$F/result"; then
    cat "$F/result" >&2
    echo "expected exit=$expected / $pattern, got exit=$result: $*" >&2; exit 1
  fi
  COUNT=$((COUNT + 1))
}
# shellcheck disable=SC2034 # Read by the sourced preflight checks.
PF_HTTP=80 PF_HTTPS=443 PF_NETWORK=internal PF_DB=sqlite
expect 0 'Docker CLI is available' preflight_cli
HIDE=docker expect 2 'Docker CLI is missing' preflight_cli
STUB_VERSION=Podman expect 2 'not supported' preflight_cli
for row in 'ubuntu:apt-get' 'debian:apt-get' 'raspbian:apt-get' 'fedora:moby-engine' 'rocky:docker-ce' 'almalinux:docker-ce' 'rhel:docker-ce' 'opensuse-leap:zypper' 'arch:pacman'; do
  distro="${row%%:*}"; expected="${row#*:}"
  # openSUSE uses ID_LIKE=suse; derivatives must work through ID_LIKE too.
  printf 'ID=%s\nID_LIKE="%s"\n' "$distro" "$([ "$distro" != opensuse-leap ] || echo suse)" >"$F/os-release"
  expect 0 "$expected" preflight_docker_hint "$F/os-release"
done
printf 'ID=custom\nID_LIKE="ubuntu debian"\n' >"$F/os-release"
expect 0 apt-get preflight_docker_hint "$F/os-release"
expect 0 'docs.docker.com' preflight_docker_hint "$F/no-release"
expect 0 reachable preflight_daemon
STUB_DAEMON=denied expect 2 'usermod -aG docker' preflight_daemon
STUB_DAEMON=stopped expect 2 'enable --now docker' preflight_daemon
expect 0 '>=2.1.1' preflight_compose
STUB_COMPOSE=missing expect 2 'legacy docker-compose v1' preflight_compose
for version in 1.29.2 2.1.0 2.1.1 2.19.9; do STUB_COMPOSE_VERSION="$version" expect 2 '>=2.20.0' preflight_compose; done
STUB_COMPOSE_VERSION=2.21.0 expect 0 'Compose 2.21.0' preflight_compose
STUB_COMPOSE_VERSION=3.0.0 expect 0 'Compose 3.0.0' preflight_compose
STUB_COMPOSE_VERSION=unknown expect 1 unknown preflight_compose
expect 0 available preflight_health_tool
HIDE=curl expect 2 'curl is missing' preflight_health_tool
expect 0 valid preflight_ports_config
PF_HTTP=0 expect 2 '1 to 65535' preflight_ports_config
PF_HTTP=65536 expect 2 '1 to 65535' preflight_ports_config
PF_HTTP=abc expect 2 '1 to 65535' preflight_ports_config
PF_HTTP=443 expect 2 differ preflight_ports_config
expect 0 workaround preflight_rootless
STUB_SECURITY=rootless expect 2 HTTP_PORT=8080 preflight_rootless
STUB_SECURITY=rootless STUB_UNPRIVILEGED=0 expect 0 'kernel permits' preflight_rootless
PF_HTTP=8080 PF_HTTPS=8443 STUB_SECURITY=rootless expect 0 workaround preflight_rootless
expect 0 available preflight_ports
STUB_LISTENERS='LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=24,fd=3))' expect 2 nginx preflight_ports
STUB_LISTENERS='LISTEN 0 128 [::]:443 [::]:*' expect 2 '443 is already in use' preflight_ports
STUB_LISTENERS='LISTEN 0 128 0.0.0.0:80 0.0.0.0:*' STUB_OWN_PORTS=80 expect 0 'skipped: 1' preflight_ports
HIDE=ss STUB_NETSTAT='tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 24/apache' expect 2 apache preflight_ports
printf '0: 00000000:0050 00000000:0000 0A\n' >"$F/procnet/tcp"
HIDE=ss,netstat expect 2 'process unknown' preflight_ports "$F/procnet"
: >"$F/procnet/tcp"
HIDE=ss,netstat expect 0 available preflight_ports "$F/procnet"
HIDE=ss,netstat expect 1 unknown preflight_ports "$F/absent"
expect 0 amd64 preflight_architecture
STUB_ARCH=armv7l expect 2 '64-bit' preflight_architecture
STUB_ARCH='' expect 1 unknown preflight_architecture
printf images >images.tar
expect 1 unknown preflight_architecture
mkdir "$F/gachipad-1.1.0-linux-arm64"
cp images.tar "$F/gachipad-1.1.0-linux-arm64/"
(cd "$F/gachipad-1.1.0-linux-arm64"; expect 2 'does not match' preflight_architecture; STUB_ARCH=aarch64 expect 0 arm64 preflight_architecture)
# Real Docker save manifest/config parsing, without building or loading any image.
mkdir "$F/archive"
printf '[{"Config":"config.json","RepoTags":["fixture"],"Layers":[]}]\n' >"$F/archive/manifest.json"
printf '{"architecture":"amd64","os":"linux"}\n' >"$F/archive/config.json"
tar -cf images.tar -C "$F/archive" manifest.json config.json
expect 0 amd64 preflight_architecture
STUB_ARCH=arm64 expect 2 'does not match' preflight_architecture
expect 0 'minimum 100 MiB' preflight_disk
STUB_DOCKER_FREE=1 expect 2 '2 x images.tar + 2 GiB' preflight_disk
STUB_FOLDER_FREE=1 expect 2 '100 MiB' preflight_disk
STUB_DOCKER_FREE=unknown expect 1 unknown preflight_disk
printf 'MemTotal: 1048576 kB\n' >"$F/memory"
expect 2 'at least 2 GiB' preflight_memory "$F/memory"
printf 'MemTotal: 3145728 kB\n' >"$F/memory"
PF_DB=mongodb expect 1 MONGO_CACHE_GB=1 preflight_memory "$F/memory"
PF_DB=sqlite expect 0 'total RAM' preflight_memory "$F/memory"
printf 'MemTotal: 8388608 kB\n' >"$F/memory"
PF_DB=mongodb expect 0 'total RAM' preflight_memory "$F/memory"
expect 1 unknown preflight_memory "$F/no-memory"
HIDE=getenforce expect 0 '[ok] selinux' preflight_selinux
expect 0 'not enforcing' preflight_selinux
STUB_SELINUX=Enforcing expect 0 'relabel options' preflight_selinux
cp docker-compose.yml "$F/compose"
sed 's/:ro,z/:ro/g' "$F/compose" >docker-compose.yml
STUB_SELINUX=Enforcing expect 2 unlabelled preflight_selinux
cp "$F/compose" docker-compose.yml
expect 0 'no active' preflight_firewall
STUB_UFW=active expect 1 'from 192.0.2.0/24' preflight_firewall
PF_NETWORK=public STUB_UFW=active expect 1 'ufw allow to any port' preflight_firewall
STUB_FIREWALLD=on expect 1 add-rich-rule preflight_firewall
PF_NETWORK=public STUB_FIREWALLD=on expect 1 --add-port=80/tcp preflight_firewall
STUB_RULES=$'table inet custom {\n chain ingress {\n type filter hook input priority 0; policy drop;\n }\n}' expect 1 'nft insert rule inet custom ingress ip saddr 192.0.2.0/24' preflight_firewall
STUB_NFT=denied expect 1 unknown preflight_firewall
expect 0 'applies to public' preflight_clock
PF_NETWORK=public expect 0 synchronized preflight_clock
PF_NETWORK=public STUB_CLOCK=no expect 1 set-ntp preflight_clock
expect 0 enabled preflight_boot
STUB_BOOT=disabled expect 1 'enable docker' preflight_boot
HIDE=systemctl expect 1 unknown preflight_boot
expect 0 'permits execution' preflight_filesystem
STUB_MOUNT=rw,noexec expect 2 noexec preflight_filesystem
for fs in vfat ntfs fuseblk 9p drvfs; do STUB_FS="$fs" expect 2 'Linux install permissions' preflight_filesystem; done
PWD='/path with spaces' expect 2 whitespace preflight_filesystem
PWD=$'/path\nnewline' expect 2 whitespace preflight_filesystem
STUB_FS='' expect 1 unknown preflight_filesystem
# Missing optional tools must produce a warning, not an unhandled command failure.
# shellcheck disable=SC2317 # Called by preflight_clock through the indirect check harness.
timedatectl() { return 127; }
PF_NETWORK=public expect 1 unknown preflight_clock
unset -f timedatectl
rm -f images.tar
unset GACHIPAD_NETWORK GACHIPAD_DB DATABASE_URL HTTP_PORT HTTPS_PORT COMPOSE_PROFILES
fingerprint() { find . -printf '%P %y %m\n' | sort; find . -type f -exec sha256sum {} \; | sort; }
fingerprint >"$F/before"
expect 0 '0 failure(s)' ./install.sh --check
fingerprint >"$F/after"
cmp "$F/before" "$F/after"
if grep -Eq '^load | pull |^compose up' "$DOCKER_CALLS"; then exit 1; fi
# Offline checksum verification also runs under --check without touching the tree.
printf 'images\n' >images.tar
sha256sum images.tar VERSION >SHA256SUMS
fingerprint >"$F/before"
expect 0 'offline bundle checksum passed' ./install.sh --check
fingerprint >"$F/after"
cmp "$F/before" "$F/after"
printf corrupt >>images.tar
expect 1 'checksum mismatch' ./install.sh --check
[ ! -e .env ] && [ ! -e state ]
rm images.tar SHA256SUMS
: >"$DOCKER_CALLS"
STUB_PULL=fail expect 1 'no internet: use the offline bundle' ./install.sh --yes --db sqlite --no-mdns
[ ! -e .env ]
if grep -q '^load ' "$DOCKER_CALLS"; then exit 1; fi
expect 1 'requires DATABASE_URL' ./install.sh --yes --db external
expect 1 'requires --domain' ./install.sh --yes --network public
: >"$DOCKER_CALLS"
MONGO_CACHE_GB=1 expect 0 'is running' ./install.sh --yes --db mongodb --no-mdns
if grep -q '^load ' "$DOCKER_CALLS"; then exit 1; fi
grep -q '^compose --env-file .env.example --profile mongodb pull --quiet$' "$DOCKER_CALLS"
grep -qx MONGO_CACHE_GB=1 .env
# --yes must never prompt even with a real terminal as stdin (network and mDNS helpers too).
rm -rf .env state
python3 - <<'PY'
import os, pty, subprocess
master, slave = pty.openpty()
try:
    p = subprocess.run(['./install.sh', '--yes', '--db', 'sqlite'],
                       stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
    assert p.returncode == 0, p.stdout.decode()
    assert all(prompt not in p.stdout for prompt in (b'Database [', b'Network [', b'Enable short name')), p.stdout.decode()
finally:
    os.close(master)
    os.close(slave)
PY
[ ! -d state/install.lock.d ]
# An installation updated by the 1.1.0 updater has the new install.sh but no preflight.sh.
mv preflight.sh "$F/preflight.sh.saved"
expect 1 'copy it from gachipad-deploy-' ./install.sh --check
rm -rf .env state
expect 0 'host checks skipped' ./install.sh --yes --db sqlite --no-mdns
STUB_EXISTING=1 expect 0 'host checks skipped' ./install.sh --yes --no-mdns
mv "$F/preflight.sh.saved" preflight.sh
STUB_EXISTING=1 fingerprint >"$F/before"
STUB_EXISTING=1 expect 0 '0 failure(s)' ./install.sh --check
fingerprint >"$F/after"
cmp "$F/before" "$F/after"
printf 'preflight.test.sh: %s direct probes and installer checksum/check/online/refusal/TTY paths passed\n' "$COUNT"
