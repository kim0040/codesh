#!/usr/bin/env bash
# Read-only Linux host checks. Each check returns 0=ok, 1=warn, 2=fail.
# Sourcing this file only defines helpers; preflight_run prints the complete report.
set -euo pipefail

preflight_result() {
  printf '[%s] %s: %s\n' "$1" "$2" "$3"
  [ -z "${4:-}" ] || printf '  fix: %s\n' "$4"
  case "$1" in ok) return 0 ;; warn) return 1 ;; *) return 2 ;; esac
}

preflight_value() {
  local name="$1" value
  value="${!name:-}"
  [ -n "$value" ] || value="$(env_get "$name" "${2:-}")"
  printf '%s' "$value"
}

preflight_docker_hint() {
  local ID="" ID_LIKE="" line key value release="${1:-/etc/os-release}"
  # Read data, never execute the release file.
  if [ -r "$release" ]; then
    while IFS= read -r line; do
      key="${line%%=*}"; value="${line#*=}"; value="${value//\"/}"; value="${value//\'/}"
      case "$key" in ID) ID="$value" ;; ID_LIKE) ID_LIKE="$value" ;; esac
    done <"$release"
  fi
  case " $ID $ID_LIKE " in
    *' ubuntu '*|*' debian '*|*' raspbian '*) echo 'sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 (if unavailable, configure https://docs.docker.com/engine/install/ and install docker-ce docker-ce-cli containerd.io docker-compose-plugin)' ;;
    *' fedora '*) echo 'sudo dnf install -y moby-engine docker-compose' ;;
    *' rhel '*|*' centos '*|*' rocky '*|*' almalinux '*) echo 'sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin (use yum on older hosts)' ;;
    *' suse '*|*' opensuse '*) echo 'sudo zypper install docker docker-compose' ;;
    *' arch '*) echo 'sudo pacman -S docker docker-compose' ;;
    *) echo 'install Docker Engine and its Compose plugin: https://docs.docker.com/engine/install/' ;;
  esac
}

preflight_cli() {
  if ! command -v docker >/dev/null 2>&1; then
    preflight_result fail docker 'Docker CLI is missing' "$(preflight_docker_hint /etc/os-release)"; return $?
  fi
  local version
  version="$(docker version 2>&1 || true)"
  if [[ "${version,,}" == *podman* ]]; then
    preflight_result fail docker 'Podman Docker emulation is not supported; install Docker Engine' "$(preflight_docker_hint /etc/os-release)"; return $?
  fi
  preflight_result ok docker 'Docker CLI is available'
}

preflight_daemon() {
  local info
  if ! info="$(docker info 2>&1)"; then
    if [[ "${info,,}" == *'permission denied'* ]]; then
      # shellcheck disable=SC2016 # The operator runs this command in their login shell.
      preflight_result fail daemon 'Docker socket permission denied' 'sudo usermod -aG docker "$USER"; then log out and log in again, or run sudo ./install.sh'
    else
      preflight_result fail daemon 'Docker daemon is unavailable' 'sudo systemctl enable --now docker (rootless: systemctl --user start docker; WSL 2: enable systemd or Docker Desktop integration)'
    fi
    return $?
  fi
  if [[ "${info,,}" == *podman* ]]; then
    preflight_result fail daemon 'Podman is not supported; install Docker Engine' "$(preflight_docker_hint /etc/os-release)"; return $?
  fi
  preflight_result ok daemon 'Docker daemon is reachable'
}

preflight_compose() {
  local version major minor patch
  if ! version="$(docker compose version --short 2>/dev/null)"; then
    preflight_result fail compose 'Compose v2 plugin is missing (legacy docker-compose v1 is not supported)' "$(preflight_docker_hint /etc/os-release)"; return $?
  fi
  if [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]]; then
    major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
    if ((10#$major < 2 || (10#$major == 2 && 10#$minor < 20))); then
      preflight_result fail compose 'need Compose >=2.20.0 for depends_on.required; up --wait alone needs >=2.1.1' "$(preflight_docker_hint /etc/os-release)"; return $?
    fi
    preflight_result ok compose "Compose $major.$minor.$patch (up --wait: >=2.1.1; this stack: >=2.20.0)"
  else
    preflight_result warn compose 'Compose version is unknown' 'docker compose version; install Compose >=2.20.0'
  fi
}

preflight_health_tool() {
  local fix
  if command -v curl >/dev/null 2>&1; then
    preflight_result ok curl 'curl is available for the required readiness check'; return $?
  fi
  case "$(preflight_docker_hint /etc/os-release)" in
    *apt-get*) fix='sudo apt-get install -y curl' ;;
    *dnf*) fix='sudo dnf install -y curl (use yum on older hosts)' ;;
    *zypper*) fix='sudo zypper install curl' ;;
    *pacman*) fix='sudo pacman -S curl' ;;
    *) fix='install curl with your distribution package manager' ;;
  esac
  preflight_result fail curl 'curl is missing; installation readiness cannot be checked' "$fix"
}

preflight_ports_config() {
  local port
  for port in "$PF_HTTP" "$PF_HTTPS"; do
    if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
      preflight_result fail ports 'HTTP_PORT and HTTPS_PORT must be integers from 1 to 65535' 'HTTP_PORT=8080 HTTPS_PORT=8443 ./install.sh'; return $?
    fi
  done
  if ((10#$PF_HTTP == 10#$PF_HTTPS)); then
    preflight_result fail ports 'HTTP_PORT and HTTPS_PORT must differ' 'HTTP_PORT=8080 HTTPS_PORT=8443 ./install.sh'; return $?
  fi
  preflight_result ok ports 'host port settings are valid'
}

preflight_rootless() {
  local security minimum
  security="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)" || security=""
  if [ -z "$security" ]; then
    preflight_result warn rootless 'Docker security mode is unknown' 'docker info --format "{{json .SecurityOptions}}"'; return $?
  fi
  if [[ "$security" == *rootless* ]] && ((10#$PF_HTTP < 1024 || 10#$PF_HTTPS < 1024)); then
    minimum="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || true)"
    if [[ "$minimum" =~ ^[0-9]+$ ]] && ((10#$PF_HTTP >= minimum && 10#$PF_HTTPS >= minimum)); then
      preflight_result ok rootless 'kernel permits the selected rootless ports'; return $?
    fi
    preflight_result fail rootless 'rootless Docker cannot bind the selected privileged ports' 'HTTP_PORT=8080 HTTPS_PORT=8443 ./install.sh; or sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0 (persist in /etc/sysctl.d/ for reboot)'; return $?
  fi
  preflight_result ok rootless 'selected ports do not require a rootless workaround'
}

preflight_ports() {
  local listeners port line project container bindings owned=0 proc_net="${1:-/proc/net}"
  if command -v ss >/dev/null 2>&1 && listeners="$(ss -ltnHp 2>/dev/null)"; then :
  elif command -v netstat >/dev/null 2>&1 && listeners="$(netstat -ltnp 2>/dev/null | awk '$1 ~ /^tcp/ {print $4, $7}')"; then :
  elif [ -r "$proc_net/tcp" ]; then
    listeners="$(awk '$4 == "0A" {print $2}' "$proc_net/tcp" "$proc_net/tcp6" 2>/dev/null || true)"
    local converted="" address hex
    while read -r address; do
      [ -n "$address" ] || continue
      hex="${address##*:}"
      [[ "$hex" =~ ^[0-9A-Fa-f]{4}$ ]] || continue
      converted+="0.0.0.0:$((16#$hex)) (process unknown)"$'\n'
    done <<<"$listeners"
    listeners="$converted"
  else
    preflight_result warn ports 'listening ports are unknown (no ss, netstat or /proc/net/tcp)' 'install iproute2 (ss), then rerun ./install.sh --check'; return $?
  fi
  project="$(database_project)"
  # Compose identity AND the absolute config directory must match this installation.
  container="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=caddy --filter "label=com.docker.compose.project.working_dir=$PWD" 2>/dev/null)" || container=""
  bindings=""
  if [ -n "$container" ]; then
    local id
    while read -r id; do
      bindings+="$(docker inspect --format '{{range $key, $ports := .NetworkSettings.Ports}}{{range $ports}}{{println .HostPort}}{{end}}{{end}}' "$id" 2>/dev/null || true)"$'\n'
    done <<<"$container"
  fi
  for port in "$PF_HTTP" "$PF_HTTPS"; do
    line="$(printf '%s\n' "$listeners" | awk -v p="$((10#$port))" '{for(i=1;i<=NF;i++) if ($i ~ ":" p "$") {print; break}}')"
    if [ -n "$line" ]; then
      if printf '%s\n' "$bindings" | grep -qx "$((10#$port))"; then owned=1; continue; fi
      # ss/netstat include process names only when visible to the invoking user.
      preflight_result fail ports "host TCP port $port is already in use: $line" 'stop the named listener, or HTTP_PORT=8080 HTTPS_PORT=8443 ./install.sh'; return $?
    fi
  done
  preflight_result ok ports "host ports are available (own installation Caddy bindings skipped: $owned)"
}

preflight_architecture() {
  local host bundle="" config manifest
  host="$(docker info --format '{{.Architecture}}' 2>/dev/null)" || host=""
  case "$host" in x86_64|amd64) host=amd64 ;; aarch64|arm64) host=arm64 ;;
    '') preflight_result warn architecture 'daemon architecture is unknown' 'docker info --format "{{.Architecture}}"'; return $? ;;
    *) preflight_result fail architecture 'released images support amd64 and arm64 only' 'use a 64-bit amd64/arm64 Docker host (Raspberry Pi: install 64-bit Raspberry Pi OS)'; return $? ;;
  esac
  if [ -f images.tar ]; then
    case "${PWD##*/}" in *-linux-amd64) bundle=amd64 ;; *-linux-arm64) bundle=arm64 ;; esac
    if [ -z "$bundle" ]; then
      manifest="$(tar -xOf images.tar manifest.json 2>/dev/null | tr -d '\n' || true)"
      config="$(printf '%s' "$manifest" | sed -n 's/.*"Config"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [ -n "$config" ]; then
        bundle="$(tar -xOf images.tar "$config" 2>/dev/null | tr -d '\n' | sed -n 's/.*"architecture"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
      fi
    fi
    if [ -z "$bundle" ]; then
      preflight_result warn architecture 'offline bundle architecture is unknown' 'use a bundle named gachipad-<version>-linux-amd64 or -linux-arm64 matching docker info'; return $?
    fi
    if [ "$bundle" != "$host" ]; then
      preflight_result fail architecture "bundle $bundle does not match Docker $host" "use the linux-$host offline bundle"; return $?
    fi
  fi
  preflight_result ok architecture "Docker $host; ${bundle:-online registry selects the platform}"
}

preflight_disk() {
  local bytes=0 root available required failures=0 unknown=0 folder
  if [ -f images.tar ]; then bytes="$(wc -c <images.tar)"; fi
  required=$((2 * bytes + 2147483648))
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || root=""
  available="$(df -Pk "${root:-/nonexistent}" 2>/dev/null | awk 'END {print $4}' || true)"
  folder="$(df -Pk . 2>/dev/null | awk 'END {print $4}' || true)"
  if [[ "$available" =~ ^[0-9]+$ ]]; then
    if ((available * 1024 < required)); then failures=1; fi
  else unknown=1; fi
  if [[ "$folder" =~ ^[0-9]+$ ]]; then
    if ((folder < 102400)); then failures=1; fi
  else unknown=1; fi
  if [ "$failures" = 1 ]; then
    preflight_result fail disk "need $required bytes at Docker root (2 x images.tar + 2 GiB), and 100 MiB at install folder" 'df -h; free space on the indicated filesystem or move Docker data-root/install folder to a larger Linux disk (do not prune shared resources)'; return $?
  fi
  if [ "$unknown" = 1 ]; then
    preflight_result warn disk 'free space at Docker root or install folder is unknown' "sudo df -Pk; verify $required bytes at Docker root and 100 MiB at install folder"; return $?
  fi
  preflight_result ok disk "Docker root has ${available} KiB free; need $required bytes; install folder has ${folder} KiB free (minimum 100 MiB)"
}

preflight_memory() {
  local total memory_file="${1:-/proc/meminfo}"
  total="$(awk '$1 == "MemTotal:" {print $2}' "$memory_file" 2>/dev/null || true)"
  if ! [[ "$total" =~ ^[0-9]+$ ]]; then
    preflight_result warn memory 'total memory is unknown' 'provision at least 2 GiB RAM (MongoDB: 4 GiB recommended)'; return $?
  fi
  if ((total < 2097152)); then
    preflight_result fail memory "only $total KiB RAM; need at least 2 GiB" 'add RAM or increase the VM/WSL 2 memory limit to at least 2 GiB'; return $?
  fi
  if [ "$PF_DB" = mongodb ] && ((total < 4194304)); then
    preflight_result warn memory 'MongoDB on less than 4 GiB RAM' 'MONGO_CACHE_GB=1 ./install.sh --db mongodb (persist MONGO_CACHE_GB=1 in .env)'; return $?
  fi
  preflight_result ok memory "$total KiB total RAM"
}

preflight_selinux() {
  local enforcing="" unlabelled
  if command -v getenforce >/dev/null 2>&1; then enforcing="$(getenforce 2>/dev/null || true)"
  elif [ -r /sys/fs/selinux/enforce ]; then enforcing="$(cat /sys/fs/selinux/enforce)"
  else preflight_result ok selinux 'SELinux enforcing is not detected'; return $?; fi
  case "$enforcing" in Enforcing|1) ;; Permissive|Disabled|0) preflight_result ok selinux 'SELinux is not enforcing'; return $? ;;
    *) preflight_result warn selinux 'SELinux state is unknown' 'getenforce; verify bind mounts have :z or :Z'; return $? ;;
  esac
  if [ ! -r docker-compose.yml ]; then
    preflight_result warn selinux 'compose file is unavailable for bind mount inspection' 'restore docker-compose.yml from the release'; return $?
  fi
  unlabelled="$(awk '/^[[:space:]]*- [./].*:\// && $0 !~ /:[^:]*[zZ]([,"]|$)/ {print}' docker-compose.yml)"
  if [ -n "$unlabelled" ]; then
    preflight_result fail selinux 'SELinux enforcing with unlabelled bind mounts' 'add :z to the access options of bind mounts in docker-compose.yml (shipped tls and state use :ro,z)'; return $?
  fi
  preflight_result ok selinux 'SELinux enforcing; bind mounts have relabel options'
}

preflight_firewall() {
  local scope="" output="" active=0 subnet interface
  interface="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i == "dev") {print $(i+1); exit}}' || true)"
  subnet="$(ip -4 route show scope link 2>/dev/null | awk -v dev="$interface" '
    $1 ~ /^[0-9]+\./ && $1 ~ /\// {
      for(i=1;i<NF;i++) if($i == "dev" && (dev == "" || $(i+1) == dev) && $(i+1) !~ /^(docker|br-|veth)/) {print $1; exit}
    }' || true)"
  subnet="${subnet:-<LAN_SUBNET_CIDR>}"
  [ "$PF_NETWORK" = public ] || scope=" from $subnet"
  if command -v ufw >/dev/null 2>&1; then
    output="$(ufw status 2>/dev/null)" || output="unknown"
    if [[ "$output" == *'Status: active'* ]]; then
      preflight_result warn firewall 'ufw is active; allow the selected TCP ports' "sudo ufw allow$scope to any port $PF_HTTP proto tcp; sudo ufw allow$scope to any port $PF_HTTPS proto tcp"; return $?
    fi
    [ "$output" != unknown ] || active=1
  fi
  if command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --state >/dev/null 2>&1; then
      if [ "$PF_NETWORK" = public ]; then
        output="sudo firewall-cmd --permanent --add-port=$PF_HTTP/tcp --add-port=$PF_HTTPS/tcp; sudo firewall-cmd --reload"
      else
        output="sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=$subnet port port=$PF_HTTP protocol=tcp accept'; sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=$subnet port port=$PF_HTTPS protocol=tcp accept'; sudo firewall-cmd --reload"
      fi
      preflight_result warn firewall 'firewalld is active; allow ports in the ingress zone' "$output"; return $?
    fi
  fi
  if command -v nft >/dev/null 2>&1; then
    output="$(nft list ruleset 2>/dev/null)" || { output=""; active=1; }
    local chain
    chain="$(printf '%s\n' "$output" | awk '/^table / {family=$2; table=$3} /chain / {chain=$2} /hook input.*policy drop/ {print family, table, chain; exit}')"
    if [ -n "$chain" ]; then
      [ "$PF_NETWORK" = public ] && scope="" || scope="ip saddr $subnet "
      preflight_result warn firewall 'nftables input default drop is active; allow ports before drop rules' "sudo nft insert rule $chain ${scope}tcp dport { $PF_HTTP, $PF_HTTPS } accept; persist with your distribution firewall manager"; return $?
    fi
  elif ! command -v ufw >/dev/null 2>&1 && ! command -v firewall-cmd >/dev/null 2>&1; then active=1
  fi
  if [ "$active" = 1 ]; then
    preflight_result warn firewall 'firewall state is unknown (tools missing or permission denied)' 'sudo nft list ruleset; check host/router rules for the selected ports (internal: restrict to the LAN subnet)'; return $?
  fi
  preflight_result ok firewall 'no active blocking firewall detected; verify upstream/router rules separately'
}

preflight_clock() {
  local synchronized
  if [ "$PF_NETWORK" != public ]; then preflight_result ok clock 'clock synchronization check applies to public mode'; return $?; fi
  synchronized="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" || synchronized=""
  if [ "$synchronized" != yes ]; then
    preflight_result warn clock 'system clock is not synchronized or unknown; ACME may fail' 'sudo timedatectl set-ntp true; timedatectl status (without systemd: enable chronyd or another NTP client)'; return $?
  fi
  preflight_result ok clock 'system clock is synchronized'
}

preflight_boot() {
  local security
  security="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null || true)"
  local -a service=(systemctl)
  [[ "$security" != *rootless* ]] || service+=(--user)
  if ! command -v systemctl >/dev/null 2>&1; then
    preflight_result warn boot 'Docker boot enablement is unknown (systemctl missing)' 'enable Docker with your init system; containers already use restart: unless-stopped'; return $?
  fi
  if ! "${service[@]}" is-enabled docker >/dev/null 2>&1; then
    preflight_result warn boot 'Docker is not enabled at boot, or service status is unknown' "${service[*]} enable docker (use sudo for a system service); containers already have restart policies"; return $?
  fi
  preflight_result ok boot 'Docker service is enabled at boot'
}

preflight_filesystem() {
  local type options="" mount path
  case "$PWD" in *' '*|*$'\n'*|*$'\r'*|*$'\t'*)
    preflight_result fail filesystem 'installation path contains whitespace' 'move the installation to a Linux filesystem path without spaces/newlines, such as /opt/gachipad'; return $? ;;
  esac
  type="$(stat -f -c %T . 2>/dev/null || true)"
  case "${type,,}" in *fat*|*ntfs*|*fuseblk*|*9p*|*drvfs*)
    preflight_result fail filesystem "filesystem $type cannot preserve Linux install permissions" 'move the installation onto a Linux filesystem (WSL 2: use ~/gachipad, not /mnt/c)'; return $? ;;
  esac
  if command -v findmnt >/dev/null 2>&1; then options="$(findmnt -n -o OPTIONS -T . 2>/dev/null || true)"; fi
  if [ -z "$options" ] && [ -r /proc/mounts ]; then
    # Longest mount prefix, including the root mount. Whitespace paths were refused above.
    path="$PWD"
    mount="$(awk -v p="$path" '($2 == "/" || p == $2 || index(p, $2 "/") == 1) && length($2) >= n {n=length($2); opts=$4} END {print opts}' /proc/mounts)"
    options="$mount"
  fi
  if [[ ",$options," == *,noexec,* ]]; then
    preflight_result fail filesystem 'installation filesystem is mounted noexec' 'move the installation to an executable Linux filesystem, such as /opt/gachipad'; return $?
  fi
  if [ -z "$options" ] || [ -z "$type" ]; then
    preflight_result warn filesystem 'filesystem type or mount options are unknown' 'findmnt -T .; verify a Linux filesystem mounted with exec'; return $?
  fi
  preflight_result ok filesystem "$type filesystem permits execution"
}

preflight_run() {
  local check status failures=0 warnings=0 docker_ready=1 ports_valid=1
  PF_HTTP="$(preflight_value HTTP_PORT 80)"; PF_HTTPS="$(preflight_value HTTPS_PORT 443)"
  PF_NETWORK="$(preflight_value GACHIPAD_NETWORK internal)"; PF_DB="$(preflight_value GACHIPAD_DB sqlite)"
  for check in filesystem cli daemon compose health_tool ports_config rootless ports architecture disk memory selinux firewall clock boot; do
    if [[ "$check" =~ ^(daemon|compose|rootless|architecture|disk|boot)$ ]] && [ "$docker_ready" = 0 ]; then
      printf '[warn] %s: unknown until Docker is available\n' "$check"; warnings=$((warnings + 1)); continue
    fi
    if [[ "$check" =~ ^(rootless|ports)$ ]] && [ "$ports_valid" = 0 ]; then continue; fi
    status=0
    "preflight_$check" || status=$?
    case "$status" in
      0) ;;
      1) warnings=$((warnings + 1)) ;;
      *) failures=$((failures + 1)); case "$check" in cli|daemon) docker_ready=0 ;; ports_config) ports_valid=0 ;; esac ;;
    esac
  done
  printf 'preflight: %s failure(s), %s warning(s); no host settings changed.\n' "$failures" "$warnings"
  [ "$failures" = 0 ]
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cd "$(dirname "$0")"
  # shellcheck source=lib.sh
  . ./lib.sh
  preflight_run
fi
