#!/usr/bin/env bash
# Regression probes for checksums: bash deploy/security-scripts.test.sh (on a docker host)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/install" "$fixture/bin"
cat >"$fixture/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
[ "$1" = compose ] && [ "${2:-}" = version ] && exit 0
if [ "$1" = volume ] && [ "${2:-}" = inspect ]; then exit 1; fi
exit 0
DOCKER
cat >"$fixture/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '200'
CURL
chmod +x "$fixture/bin/docker"
chmod +x "$fixture/bin/curl"
export PATH="$fixture/bin:$PATH" DOCKER_CALLS="$fixture/docker.calls"
cp "$root"/deploy/{install.sh,upgrade.sh,update.sh,backup.sh,restore.sh,generate-secrets.sh,lib.sh} "$fixture/install/"
printf 'security-test\n' >"$fixture/install/VERSION"
printf 'original image bytes\n' >"$fixture/install/images.tar"
(cd "$fixture/install" && sha256sum images.tar VERSION >SHA256SUMS)
printf 'corruption\n' >>"$fixture/install/images.tar"
if bash "$fixture/install/install.sh" >"$fixture/install.log" 2>&1; then
  echo 'installer accepted a corrupt image archive' >&2; exit 1
fi
grep -q 'checksum mismatch' "$fixture/install.log"
if grep -q '^load ' "$DOCKER_CALLS"; then echo 'corrupt images loaded' >&2; exit 1; fi
# The upgrade must refuse a changed archive before extraction, backup or image loading.
touch "$fixture/install/.env"
printf 'not an archive\n' >"$fixture/bundle.tar.gz"
sha256sum "$fixture/bundle.tar.gz" >"$fixture/bundle.tar.gz.sha256"
printf 'changed\n' >>"$fixture/bundle.tar.gz"
if bash "$fixture/install/upgrade.sh" "$fixture/bundle.tar.gz" >"$fixture/upgrade.log" 2>&1; then
  echo 'upgrade accepted a corrupt archive' >&2; exit 1
fi
grep -q 'bundle checksum mismatch' "$fixture/upgrade.log"
if grep -q '^load ' "$DOCKER_CALLS"; then echo 'corrupt images loaded' >&2; exit 1; fi
echo 'L11: install and upgrade rejected corrupt bundles before image loading'

make_install() {
  local dir="$1"
  mkdir -p "$dir/state"
  cp "$root"/deploy/{install.sh,generate-secrets.sh,lib.sh,backup.sh,restore.sh,upgrade.sh,update.sh,docker-compose.yml,.env.example} "$dir/"
  printf '1.2.3\n' >"$dir/VERSION"
  printf 'fixture images\n' >"$dir/images.tar"
  (cd "$dir" && sha256sum images.tar VERSION >SHA256SUMS)
}

for choice in sqlite postgres mongodb; do
  dir="$fixture/$choice"
  make_install "$dir"
  : >"$DOCKER_CALLS"
  if [ "$choice" = postgres ]; then
    (cd "$dir" && GACHIPAD_DB=sqlite ./install.sh --db "$choice") >"$fixture/$choice.log" 2>&1
  else
    (cd "$dir" && ./install.sh --db "$choice") >"$fixture/$choice.log" 2>&1
  fi
  grep -qx "GACHIPAD_DB=$choice" "$dir/.env"
  grep -q "install: database $choice; selected with --db $choice" "$fixture/$choice.log"
  if [ "$choice" = postgres ]; then
    grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{64}$' "$dir/.env"
    grep -qx 'COMPOSE_PROFILES=postgres' "$dir/.env"
    password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$dir/.env")"
    if grep -qF "$password" "$fixture/$choice.log"; then echo 'PostgreSQL password was printed' >&2; exit 1; fi
  elif [ "$choice" = mongodb ]; then grep -qx 'COMPOSE_PROFILES=mongodb' "$dir/.env"
  else
    grep -qx "GACHIPAD_DATABASE_URL='sqlite:///data/gachipad.db'" "$dir/.env"
    grep -qx 'COMPOSE_PROFILES=' "$dir/.env"
  fi
  [ "$(cat "$dir/state/database-kind")" = "$choice" ]
done

url='mysql://user:p%40ss@db.local/gachipad?ssl=true&charset=utf8mb4'
dir="$fixture/external"
make_install "$dir"
(cd "$dir" && ./install.sh --database-url "$url") >"$fixture/external.log" 2>&1
grep -qx 'GACHIPAD_DB=external' "$dir/.env"
grep -qxF "DATABASE_URL='$url'" "$dir/.env"
grep -qx 'GACHIPAD_DATABASE_URL=' "$dir/.env"
grep -q 'install: database external; DATABASE_URL was supplied' "$fixture/external.log"
if grep -qF 'p%40ss' "$fixture/external.log"; then echo 'external URL was printed' >&2; exit 1; fi
dir="$fixture/external-env"
make_install "$dir"
(cd "$dir" && DATABASE_URL="$url" ./install.sh) >"$fixture/external-env.log" 2>&1
grep -qxF "DATABASE_URL='$url'" "$dir/.env"
grep -qx 'GACHIPAD_DB=external' "$dir/.env"
if grep -qF 'p%40ss' "$fixture/external-env.log"; then echo 'environment DATABASE_URL was printed' >&2; exit 1; fi

dir="$fixture/invalid"
make_install "$dir"
: >"$DOCKER_CALLS"
if (cd "$dir" && ./install.sh --database-url 'file:///private/secret') >"$fixture/invalid.log" 2>&1; then
  echo 'installer accepted an unsupported DATABASE_URL scheme' >&2; exit 1
fi
grep -q 'DATABASE_URL has an unsupported scheme' "$fixture/invalid.log"
if grep -q 'private/secret' "$fixture/invalid.log"; then echo 'invalid URL was printed' >&2; exit 1; fi
if grep -q '^load ' "$DOCKER_CALLS"; then echo 'invalid URL reached image loading' >&2; exit 1; fi

dir="$fixture/switch"
make_install "$dir"
printf 'mongodb\n' >"$dir/state/database-kind"
cp "$dir/.env.example" "$dir/.env"
cp "$dir/.env" "$fixture/switch-before.env"
: >"$DOCKER_CALLS"
if (cd "$dir" && PUBLIC_URL=http://should-not-write ./install.sh --db postgres) >"$fixture/switch.log" 2>&1; then
  echo 'installer accepted a backend switch from existing data' >&2; exit 1
fi
grep -q 'database backend change refused (mongodb -> postgres)' "$fixture/switch.log"
grep -q 'future copy tool' "$fixture/switch.log"
cmp "$dir/.env" "$fixture/switch-before.env"
# Exported selections and missing external URLs also leave every existing byte intact.
for mode in env url external; do
  case "$mode" in
    env) command=(env GACHIPAD_DB=postgres ./install.sh) ;;
    url) command=(env DATABASE_URL=postgresql://fixture:private@db.invalid/db ./install.sh) ;;
    external) command=(./install.sh --db external) ;;
  esac
  if (cd "$dir" && "${command[@]}") >"$fixture/refused-$mode.log" 2>&1; then
    echo "installer accepted refused $mode selection" >&2; exit 1
  fi
  cmp "$dir/.env" "$fixture/switch-before.env"
done
grep -q 'requires DATABASE_URL' "$fixture/refused-external.log"
# A hand-run generator must also enforce the persisted backend marker atomically.
if (cd "$dir" && GACHIPAD_DB=postgres ./generate-secrets.sh) >"$fixture/generate-refused.log" 2>&1; then
  echo 'generator accepted a recorded backend switch' >&2; exit 1
fi
cmp "$dir/.env" "$fixture/switch-before.env"
grep -q 'database backend change refused' "$fixture/generate-refused.log"
if grep -q '^compose up' "$DOCKER_CALLS"; then echo 'backend switch started Compose' >&2; exit 1; fi
echo 'L12: install selects sqlite, postgres, mongodb or external without printing URLs or secrets; backend switches are refused'

# No flags means the recommendation, independent of host detection results.
dir="$fixture/default"
make_install "$dir"
(cd "$dir" && ./install.sh) >"$fixture/default.log" 2>&1
grep -qx GACHIPAD_DB=sqlite "$dir/.env"
grep -q 'recommended because' "$fixture/default.log"

# Literal Compose values must survive env_get and repeat secret generation, without evaluation.
dir="$fixture/literal"
make_install "$dir"
url="postgresql://user:literal\$TOKEN#password@db.local/db?label=it's-literal"
(cd "$dir" && DATABASE_URL="$url" ./install.sh) >"$fixture/literal.log" 2>&1
(
  cd "$dir"
  # shellcheck source=/dev/null
  source ./lib.sh
  [ "$(env_get DATABASE_URL)" = "$url" ]
  ./generate-secrets.sh >/dev/null
  [ "$(env_get DATABASE_URL)" = "$url" ]
)
# shellcheck disable=SC2016 # the password deliberately contains a literal dollar sign
if grep -qF 'literal$TOKEN#password' "$fixture/literal.log"; then echo 'literal URL leaked' >&2; exit 1; fi
url=$'postgresql://user:secret@db.local/db\nINJECTED=value'
if (cd "$dir" && DATABASE_URL="$url" ./install.sh) >"$fixture/newline.log" 2>&1; then
  echo 'multiline DATABASE_URL was accepted' >&2; exit 1
fi
if grep -q '^INJECTED=' "$dir/.env"; then echo 'DATABASE_URL injected an env setting' >&2; exit 1; fi
echo 'L13: no-flag SQLite recommendation, literal URL roundtrip and newline rejection passed'

# Compose also accepts double-quoted URLs. Both host helpers must read the scheme correctly.
dir="$fixture/quoted"
make_install "$dir"
printf 'GACHIPAD_DB=external\nDATABASE_URL="postgresql://fixture:private@db.invalid/db"\n' >"$dir/.env"
(
  cd "$dir"
  # shellcheck source=/dev/null
  source ./lib.sh
  [ "$(database_kind)" = external ]
  ./generate-secrets.sh >/dev/null
  [ "$(database_kind)" = external ]
)
echo 'L14: refused installs and secret generation preserve .env bytes; double-quoted URL schemes work'
