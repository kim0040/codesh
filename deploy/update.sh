#!/usr/bin/env bash
# Updates an installed codesh to a newer GitHub release (docs/OPERATIONS.md "업데이트").
#
#   ./update.sh --check                  installed and newest release; changes nothing
#   ./update.sh [--yes]                  the newest release (refuses a new major version)
#   ./update.sh --version 1.4.2          that release
#   ./update.sh --allow-major            also across a major version; read its notes first
#   ./update.sh --bundle <file.tar.gz>   no internet: the offline path, ./upgrade.sh <file>
#   ./update.sh --enable-auto [--at 04:00] [--policy patch|minor]    opt-in daily updates
#   ./update.sh --disable-auto
#   ./update.sh --auto                   what the timer runs: only what the policy allows
#   --dry-run                            with --enable-auto / --disable-auto: print, change nothing
#
# Online: release list -> SHA256SUMS -> codesh-deploy-<v>.tar.gz checked against it -> its own
# SHA256SUMS -> backup.sh -> new files and CODESH_VERSION -> docker compose pull -> image digests
# (IMAGES) -> up -d -> /healthz and /readyz. If the new version does not get healthy, the previous
# files and version come back, the previous images (still on the host) start and the backup is
# restored. Every run is logged to state/update.log; state/update.json is what the admin console shows.
#
# Settings, from the environment or .env: UPDATE_REPO (kim0040/codesh), UPDATE_CHANNEL (stable or
# prerelease), UPDATE_API_URL (https://api.github.com), UPDATE_DOWNLOAD_URL (https://github.com),
# UPDATE_HEALTH_TIMEOUT (180 s). No credentials: the release API and the images are public.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
. ./lib.sh

STATE=state
LOG="$STATE/update.log"
STATUS="$STATE/update.json"
LAST_RUN="$STATE/last-run"
AUTO_CONF="$STATE/auto.conf"
ROLLBACK="$STATE/rollback"
UNIT=codesh-update
SYSTEMD_DIR="${CODESH_SYSTEMD_DIR:-/etc/systemd/system}"
CRON_TAG="# codesh-update $(pwd)"
FILES="docker-compose.yml .env.example VERSION IMAGES lib.sh generate-secrets.sh install.sh upgrade.sh update.sh backup.sh restore.sh README.md"

usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "$0"; }

say() { printf '%s update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# setting NAME default: the environment wins over .env
setting() {
  local value="${!1:-}"
  [ -n "$value" ] || value="$(env_get "$1")"
  printf '%s' "${value:-$2}"
}

# --- versions ------------------------------------------------------------------------------------

# semver_ok v: a release (1.2.3) or pre-release (1.2.3-rc.1) version
semver_ok() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; }
major() { printf '%s' "${1%%.*}"; }
minor() { local rest="${1#*.}"; printf '%s' "${rest%%.*}"; }

# version_gt a b: a is newer than b (a release is newer than its own pre-releases)
version_gt() {
  [ "$1" = "$2" ] && return 1
  local a="${1%%-*}" b="${2%%-*}"
  if [ "$a" != "$b" ]; then
    [ "$(printf '%s\n%s\n' "$a" "$b" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$a" ]
    return
  fi
  [ "$1" = "$a" ] && return 0
  [ "$2" = "$b" ] && return 1
  [ "$(printf '%s\n%s\n' "${1#*-}" "${2#*-}" | sort -V | tail -n 1)" = "${1#*-}" ]
}

# --- downloads -----------------------------------------------------------------------------------

# fetch url file [seconds]: GET without credentials or cookies
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,http' --max-time "${3:-30}" -A "codesh-update/$CURRENT" \
      -H 'Accept: application/vnd.github+json' -o "$2" "$1"
  else
    wget -q -T "${3:-30}" -U "codesh-update/$CURRENT" -O "$2" "$1"
  fi
}

# releases: the published versions, newest first (drafts are never listed without a login;
# a pre-release is a version with a suffix, see RELEASING.md)
releases() {
  local file="$WORK/releases.json"
  fetch "$API/repos/$REPO/releases?per_page=50" "$file" || return 1
  { grep -o '"tag_name": *"[^"]*"' "$file" || true; } | sed 's/.*"v\{0,1\}\([^"]*\)"$/\1/' | while read -r v; do
    semver_ok "$v" || continue
    [ "$CHANNEL" = prerelease ] || [[ "$v" != *-* ]] || continue
    printf '%s\n' "$v"
  done
}

# newest <list> <policy>: the newest version above CURRENT the policy allows (any|major|patch|minor)
newest() {
  local best="" v
  for v in $1; do
    version_gt "$v" "$CURRENT" || continue
    case "$2" in
      patch) [ "$(major "$v").$(minor "$v")" = "$(major "$CURRENT").$(minor "$CURRENT")" ] || continue ;;
      minor | major) [ "$(major "$v")" = "$(major "$CURRENT")" ] || continue ;;
    esac
    if [ -z "$best" ] || version_gt "$v" "$best"; then best="$v"; fi
  done
  printf '%s' "$best"
}

# --- status for the admin console ----------------------------------------------------------------

json_str() {
  [ -n "$1" ] || { printf 'null'; return; }
  local s="${1:0:300}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$(printf '%s' "$s" | tr -d '\000-\037')"
}

write_status() {
  local auto="null" AT="" POLICY="" LAST_AT="" LAST_RESULT="" LAST_FROM="" LAST_TO="" LAST_MESSAGE=""
  # shellcheck disable=SC1090
  [ -f "$AUTO_CONF" ] && . "$AUTO_CONF"
  [ -f "$AUTO_CONF" ] && auto="{\"enabled\":true,\"at\":$(json_str "$AT"),\"policy\":$(json_str "$POLICY")}"
  [ -f "$AUTO_CONF" ] || auto='{"enabled":false,"at":null,"policy":null}'
  # shellcheck disable=SC1090
  [ -f "$LAST_RUN" ] && . "$LAST_RUN"
  local last="null"
  [ -n "$LAST_AT" ] && last="{\"at\":\"$LAST_AT\",\"result\":\"$LAST_RESULT\",\"from\":$(json_str "$LAST_FROM"),\"to\":$(json_str "$LAST_TO"),\"message\":$(json_str "$LAST_MESSAGE")}"
  printf '{"auto":%s,"lastRun":%s}\n' "$auto" "$last" >"$STATUS.tmp"
  # api runs as another user and mounts state/ read-only.
  chmod 644 "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

# record result from to message (not for --check, which changes nothing)
record() {
  [ "$MODE" = check ] && return 0
  {
    printf 'LAST_AT=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'LAST_RESULT=%q\nLAST_FROM=%q\nLAST_TO=%q\nLAST_MESSAGE=%q\n' "$1" "${2:-}" "${3:-}" "${4:-}"
  } >"$LAST_RUN"
  write_status
}

# fail result message: records, logs and exits (1, or 3 for a refusal)
fail() {
  record "$1" "$CURRENT" "${TARGET:-}" "$2"
  say "$2" >&2
  [ "$1" = refused ] && exit 3
  exit 1
}

# --- automatic updates ---------------------------------------------------------------------------

init_system() {
  if [ -n "${CODESH_INIT:-}" ]; then printf '%s' "$CODESH_INIT"
  elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then printf systemd
  else printf cron; fi
}

# run cmd...: runs it, or prints it with --dry-run
run() {
  if [ "$DRY" = 1 ]; then printf 'dry-run: %s\n' "$*"; else "$@"; fi
}

# put file content: writes it, or prints it with --dry-run
put() {
  if [ "$DRY" = 1 ]; then printf 'dry-run: write %s:\n%s\n' "$1" "$2"; else printf '%s\n' "$2" >"$1" && chmod 644 "$1"; fi
}

enable_auto() {
  [[ "$AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "--at needs HH:MM, for example 04:00"
  [ "$POLICY" = patch ] || [ "$POLICY" = minor ] || die "--policy is patch or minor"
  local dir init
  dir="$(pwd)"
  init="$(init_system)"
  if [ "$init" = systemd ]; then
    [ "$DRY" = 1 ] || [ -w "$SYSTEMD_DIR" ] || die "writing $SYSTEMD_DIR needs root: sudo ./update.sh --enable-auto ..."
    put "$SYSTEMD_DIR/$UNIT.service" "[Unit]
Description=codesh automatic update ($dir)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$dir/update.sh --auto"
    put "$SYSTEMD_DIR/$UNIT.timer" "[Unit]
Description=Daily codesh update window

[Timer]
OnCalendar=*-*-* $AT:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target"
    run systemctl daemon-reload
    run systemctl enable --now "$UNIT.timer"
  else
    command -v crontab >/dev/null 2>&1 || die "neither systemd nor crontab is available"
    local line="$((10#${AT#*:})) $((10#${AT%:*})) * * * cd '$dir' && ./update.sh --auto >/dev/null 2>&1 $CRON_TAG"
    if [ "$DRY" = 1 ]; then
      printf 'dry-run: crontab entry: %s\n' "$line"
    else
      { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; printf '%s\n' "$line"; } | crontab -
    fi
  fi
  put "$AUTO_CONF" "AT=$AT
POLICY=$POLICY
VIA=$init"
  [ "$DRY" = 1 ] && return
  write_status
  say "automatic updates on: daily at $AT ($init), policy $POLICY"
}

disable_auto() {
  local init
  init="$(init_system)"
  if [ "$init" = systemd ]; then
    if [ -f "$SYSTEMD_DIR/$UNIT.timer" ] || [ "$DRY" = 1 ]; then
      run systemctl disable --now "$UNIT.timer"
      run rm -f "$SYSTEMD_DIR/$UNIT.timer" "$SYSTEMD_DIR/$UNIT.service"
      run systemctl daemon-reload
    fi
  elif command -v crontab >/dev/null 2>&1; then
    if [ "$DRY" = 1 ]; then
      printf 'dry-run: remove the crontab entry ending in "%s"\n' "$CRON_TAG"
    else
      { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
    fi
  fi
  run rm -f "$AUTO_CONF"
  [ "$DRY" = 1 ] && return
  write_status
  say "automatic updates off"
}

# --- the update ----------------------------------------------------------------------------------

# install_files src: the new compose file and scripts, each as a new inode (this script is one)
install_files() {
  local file
  for file in $FILES; do
    [ -f "$1/$file" ] && cp "$1/$file" "./$file.new" && mv "./$file.new" "./$file"
  done
  mkdir -p docs && cp "$1"/docs/* docs/ 2>/dev/null || true
  mkdir -p tls && cp -n "$1"/tls/*.example tls/ 2>/dev/null || true
}

# verify_images: the pulled images are the ones the release built (IMAGES: name sha256:digest)
verify_images() {
  [ -f IMAGES ] || { say "no IMAGES list in this release; image digests not checked"; return 0; }
  local name digest ref registry
  registry="$(setting CODESH_REGISTRY ghcr.io/kim0040)"
  while read -r name digest; do
    [ -n "$name" ] || continue
    ref="$registry/$name:$TARGET"
    # Only images this installation uses (mdns is optional).
    docker compose config --images | grep -qxF "$ref" || continue
    docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | grep -q "@$digest\$" ||
      { say "$ref is not the released image $digest" >&2; return 1; }
  done <IMAGES
}

healthy() {
  docker compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" &&
    wait_healthy "$HEALTH_TIMEOUT" /healthz && wait_healthy 60 /readyz
}

rollback() {
  say "codesh $TARGET did not get healthy: rolling back to $CURRENT"
  local file
  for file in $FILES .env; do
    [ -f "$ROLLBACK/$file" ] && cp "$ROLLBACK/$file" "./$file.new" && mv "./$file.new" "./$file"
  done
  if ! healthy; then
    fail failed "rollback to $CURRENT did not get healthy either; see $LOG and docker compose logs"
  fi
  if [ -n "$BACKUP" ]; then
    say "restoring the database from $BACKUP"
    ./restore.sh "$BACKUP" --yes || fail failed "rolled back to $CURRENT, but restoring $BACKUP failed"
  fi
  record rolled-back "$CURRENT" "$TARGET" "$TARGET did not get healthy; back on $CURRENT"
  say "rolled back: codesh $CURRENT is running"
  exit 1
}

update() {
  local mode="$1" list
  [ -f .env ] || die "no .env here: this is not an installed codesh"
  if [ -e ../.git ] && [ -f ../package.json ] && [ "$mode" != check ]; then
    die "this is a source checkout: update it with git pull && docker compose build && docker compose up -d"
  fi
  if [ -z "$TARGET" ]; then
    semver_ok "$CURRENT" || die "installed version '$CURRENT' is not a release; pass --version X.Y.Z"
    list="$(releases)" || fail failed "cannot reach $API (no internet? use --bundle <file>)"
    case "$mode" in
      auto) TARGET="$(newest "$list" "$AUTO_POLICY")" ;;
      *)
        TARGET="$(newest "$list" any)"
        local same
        same="$(newest "$list" major)"
        if [ "$mode" = check ]; then
          say "installed $CURRENT, newest ${TARGET:-$CURRENT} (channel $CHANNEL, $REPO)"
          if [ -z "$TARGET" ]; then say "up to date"
          elif [ "$(major "$TARGET")" != "$(major "$CURRENT")" ] && [ -n "$same" ]; then
            say "update with ./update.sh (to $same) or ./update.sh --allow-major (to $TARGET)"
          elif [ "$(major "$TARGET")" != "$(major "$CURRENT")" ]; then
            say "update with ./update.sh --allow-major (to $TARGET); read its release notes first"
          else say "update with ./update.sh (to $TARGET)"; fi
          return 0
        fi
        if [ -n "$TARGET" ] && [ "$(major "$TARGET")" != "$(major "$CURRENT")" ] && [ "$ALLOW_MAJOR" != 1 ]; then
          if [ -n "$same" ]; then
            say "$TARGET is a new major version; updating to $same, the newest $(major "$CURRENT").x (--allow-major for $TARGET)"
            TARGET="$same"
          else
            fail refused "$TARGET is a new major version: read its release notes, then ./update.sh --allow-major"
          fi
        fi
        ;;
    esac
  else
    semver_ok "$TARGET" || die "--version needs X.Y.Z"
    if semver_ok "$CURRENT" && [ "$(major "$TARGET")" != "$(major "$CURRENT")" ] && [ "$ALLOW_MAJOR" != 1 ]; then
      fail refused "$TARGET is a new major version: read its release notes, then add --allow-major"
    fi
    if semver_ok "$CURRENT" && ! version_gt "$TARGET" "$CURRENT" && [ "$TARGET" != "$CURRENT" ]; then
      fail refused "$TARGET is older than $CURRENT: go back with ./restore.sh and the backup instead"
    fi
  fi
  if [ -z "$TARGET" ] || [ "$TARGET" = "$CURRENT" ]; then
    [ "$mode" = check ] || record up-to-date "$CURRENT" "$CURRENT" ""
    say "codesh $CURRENT is up to date"
    return 0
  fi
  if [ "$mode" = check ]; then say "installed $CURRENT, available $TARGET"; return 0; fi

  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "add --yes to update without a terminal"
    read -r -p "Update codesh $CURRENT -> $TARGET? [y/N] " answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "cancelled"
  fi

  say "updating $CURRENT -> $TARGET"
  local base="$DOWNLOAD/$REPO/releases/download/v$TARGET" asset="codesh-deploy-$TARGET.tar.gz" expected
  fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS" || fail failed "cannot download SHA256SUMS of v$TARGET"
  expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$WORK/SHA256SUMS" | head -n 1)"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail failed "SHA256SUMS of v$TARGET does not list $asset"
  fetch "$base/$asset" "$WORK/$asset" 600 || fail failed "cannot download $asset"
  [ "$(sha256_file "$WORK/$asset")" = "$expected" ] || fail failed "checksum mismatch: $asset is not the released file"
  mkdir "$WORK/x"
  tar xzf "$WORK/$asset" -C "$WORK/x"
  local src
  src="$(find "$WORK/x" -maxdepth 2 -name docker-compose.yml -exec dirname {} \; | head -n 1)"
  [ -n "$src" ] || fail failed "$asset is not a codesh release"
  (verify_bundle "$src") || fail failed "content checksum mismatch in $asset"
  [ "$(cat "$src/VERSION")" = "$TARGET" ] || fail failed "$asset is for version $(cat "$src/VERSION")"

  # What a rollback needs: these files and .env. The images stay on the host.
  rm -rf "$ROLLBACK" && mkdir -p "$ROLLBACK"
  local file
  for file in $FILES .env; do [ -f "$file" ] && cp -p "$file" "$ROLLBACK/"; done

  local out
  out="$(./backup.sh ./backups)" || fail failed "backup failed; nothing was changed"
  printf '%s\n' "$out"
  BACKUP="$(sed -n 's/^backup: \(.*\) ([0-9]* bytes)$/\1/p' <<<"$out")"

  install_files "$src"
  env_set CODESH_VERSION "$TARGET"
  # Settings added by the new version are filled in; existing values stay.
  local name
  for name in $(sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' .env.example); do
    grep -q "^$name=" .env || sed -n "s/^$name=.*/&/p" .env.example >>.env
  done
  ./generate-secrets.sh .env >/dev/null

  if ! docker compose pull || ! verify_images; then
    # Nothing was restarted yet: put the files back and stop.
    for file in $FILES .env; do
      [ -f "$ROLLBACK/$file" ] && cp "$ROLLBACK/$file" "./$file.new" && mv "./$file.new" "./$file"
    done
    fail failed "pulling the images of $TARGET failed; nothing was restarted"
  fi
  healthy || rollback
  record updated "$CURRENT" "$TARGET" ""
  say "codesh $TARGET is running (backup: ${BACKUP:-none})"
}

main() {
  local mode=update
  MODE=update TARGET="" YES=0 ALLOW_MAJOR=0 DRY=0 AT=04:00 POLICY=patch BUNDLE="" BACKUP=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check) mode=check ;;
      --version) TARGET="${2:?--version needs X.Y.Z}"; TARGET="${TARGET#v}"; shift ;;
      --yes | -y) YES=1 ;;
      --allow-major) ALLOW_MAJOR=1 ;;
      --bundle) BUNDLE="${2:?--bundle needs a file}"; mode=bundle; shift ;;
      --auto) mode=auto; YES=1 ;;
      --enable-auto) mode=enable-auto ;;
      --disable-auto) mode=disable-auto ;;
      --at) AT="${2:?--at needs HH:MM}"; shift ;;
      --policy) POLICY="${2:?--policy needs patch or minor}"; shift ;;
      --dry-run) DRY=1 ;;
      -h | --help) usage; return 0 ;;
      *) die "unknown option $1 (./update.sh --help)" ;;
    esac
    shift
  done
  MODE="$mode"

  mkdir -p "$STATE" && chmod 755 "$STATE"
  # Rotate at 1 MiB, keep three old logs.
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 1048576 ]; then
    for n in 2 1; do [ -f "$LOG.$n" ] && mv "$LOG.$n" "$LOG.$((n + 1))"; done
    mv "$LOG" "$LOG.1"
  fi
  [ "$DRY" = 1 ] || exec > >(tee -a "$LOG") 2>&1

  CURRENT="$(env_get CODESH_VERSION)"
  REPO="$(setting UPDATE_REPO kim0040/codesh)"
  CHANNEL="$(setting UPDATE_CHANNEL stable)"
  API="$(setting UPDATE_API_URL https://api.github.com)"
  DOWNLOAD="$(setting UPDATE_DOWNLOAD_URL https://github.com)"
  HEALTH_TIMEOUT="$(setting UPDATE_HEALTH_TIMEOUT 180)"
  [[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "UPDATE_REPO must look like owner/name"

  case "$mode" in
    enable-auto) enable_auto; return ;;
    disable-auto) disable_auto; return ;;
  esac

  need_docker
  # One run at a time: a manual run and the timer must not overlap.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$STATE/update.lock"
    flock -n 9 || die "another update.sh is running"
  fi
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  case "$mode" in
    bundle)
      TARGET=""
      ./upgrade.sh "$BUNDLE" || fail failed "./upgrade.sh $BUNDLE failed"
      record updated "$CURRENT" "$(env_get CODESH_VERSION)" "offline bundle"
      ;;
    auto)
      [ -f "$AUTO_CONF" ] || die "automatic updates are off (./update.sh --enable-auto)"
      AUTO_POLICY="$(sed -n 's/^POLICY=//p' "$AUTO_CONF")"
      [ "$AUTO_POLICY" = minor ] || AUTO_POLICY="patch"
      update auto
      ;;
    *) update "$mode" ;;
  esac
}

# The script file is replaced while it runs; bash must not read on after this line.
main "$@"; exit $?
