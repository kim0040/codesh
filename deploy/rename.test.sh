#!/usr/bin/env bash
# legacy codesh name (1.0.x); remove in 2.0
# The new helper is invoked by the installed v1.0.1 updater before starting the new compose file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT/generate-secrets.sh" "$ROOT/.env.example" "$WORK/"
cd "$WORK"
cat >.env <<'ENV'
CODESH_VERSION=1.0.2
CODESH_REGISTRY=ghcr.io/custom
SESSION_SECRET=keep-session
COLLAB_SECRET=keep-collab
MONGO_PASSWORD=keep-root
MONGO_APP_PASSWORD=keep-app
VALKEY_PASSWORD=keep-valkey
ADMIN_TOKEN=keep-admin
COMPOSE_PROFILES=mdns
MDNS_HOSTNAME=codesh.local
SITE_ADDRESS=https://codesh.local
ENV
cp .env orig.env
bash generate-secrets.sh >/dev/null
for setting in GACHIPAD_VERSION=1.0.2 GACHIPAD_REGISTRY=ghcr.io/custom GACHIPAD_PROJECT=codesh GACHIPAD_DB=mongodb COMPOSE_PROFILES=mdns,mongodb MONGO_ROOT_USER=codesh MONGO_APP_USER=codesh_app MONGO_DATABASE=codesh MDNS_HOSTNAME=gachipad.local MDNS_ALIASES=codesh.local SITE_ADDRESS=https://codesh.local SESSION_SECRET=keep-session; do
  grep -qxF "$setting" .env || { echo "missing $setting" >&2; exit 1; }
done
# The migrated lines are kept as comments, so nothing warns about them and the unmodified
# 1.0.1 updater (which only greps live "CODESH_X=" lines) ignores them.
if grep -q '^CODESH_' .env; then echo "legacy lines left active" >&2; exit 1; fi
grep -qxF '# migrated to GACHIPAD_*: CODESH_VERSION=1.0.2' .env
grep -qxF '# migrated to GACHIPAD_*: CODESH_REGISTRY=ghcr.io/custom' .env
[ "$(stat -c %a .env)" = 600 ]
[ -z "$(find . -maxdepth 1 -name '.env.??????' -print)" ] || { echo "temp file left behind" >&2; exit 1; }
# No operator certificate for the new name: the HTTPS host gets no alias.
if grep -q '^SITE_ALIASES=.' .env; then echo "alias without a certificate" >&2; exit 1; fi
cp .env before.env
bash generate-secrets.sh >/dev/null
cmp .env before.env
# Offline bundles may come from a different registry than the operator's old mirror.
cp orig.env .env
touch images.tar
bash generate-secrets.sh >/dev/null
grep -qx 'GACHIPAD_REGISTRY=ghcr.io/kim0040' .env
grep -qxF '# migrated to GACHIPAD_*: CODESH_REGISTRY=ghcr.io/custom' .env
rm images.tar
sed 's/^MDNS_HOSTNAME=.*/MDNS_HOSTNAME=custom.local/' orig.env >.env
bash generate-secrets.sh >/dev/null
grep -qx 'MDNS_HOSTNAME=custom.local' .env
if grep -q '^MDNS_ALIASES=' .env; then exit 1; fi
# The HTTPS alias exists only when Caddy mints a certificate for it (tls internal).
mkdir tls
printf 'tls /etc/caddy/tls/codesh.crt /etc/caddy/tls/codesh.key\n' >tls/local.caddy
cp orig.env .env
bash generate-secrets.sh >/dev/null
if grep -q '^SITE_ALIASES=.' .env; then echo "alias with an operator certificate" >&2; exit 1; fi
printf 'tls internal\nheader Strict-Transport-Security "max-age=31536000"\n' >tls/local.caddy
cp orig.env .env
bash generate-secrets.sh >/dev/null
grep -qxF 'SITE_ALIASES=, gachipad.local' .env
# The v1.0.1 updater runs the helper in a staged copy; it exports the installation's lock path.
mkdir -p live/tls live/state staged
mv tls/local.caddy live/tls/
cp generate-secrets.sh .env.example staged/
cp orig.env staged/.env
(cd staged && CODESH_LOCK_PATH="$WORK/live/state/install.lock" bash generate-secrets.sh .env >/dev/null)
grep -qxF 'SITE_ALIASES=, gachipad.local' staged/.env
cp orig.env staged/.env
(cd staged && bash generate-secrets.sh .env >/dev/null)
if grep -q '^SITE_ALIASES=.' staged/.env; then echo "alias without a visible certificate" >&2; exit 1; fi
rm -rf live staged tls
# Plain HTTP needs no certificate.
sed 's|^SITE_ADDRESS=.*|SITE_ADDRESS=http://codesh.local|' orig.env >.env
bash generate-secrets.sh >/dev/null
grep -qxF 'SITE_ALIASES=, http://gachipad.local' .env
# A hand-trimmed .env: the updater appended the template's gachipad.local before the helper ran.
sed 's/^MDNS_HOSTNAME=.*/MDNS_HOSTNAME=gachipad.local/' orig.env >.env
bash generate-secrets.sh >/dev/null
grep -qx 'MDNS_ALIASES=codesh.local' .env
rm .env
bash generate-secrets.sh >/dev/null
if grep -qi codesh .env; then exit 1; fi
grep -qx 'GACHIPAD_DB=sqlite' .env
grep -qx "GACHIPAD_DATABASE_URL='sqlite:///data/gachipad.db'" .env
mkdir choices
cp generate-secrets.sh .env.example choices/
(cd choices && ./generate-secrets.sh sqlite.env >/dev/null)
grep -qx 'GACHIPAD_DB=sqlite' choices/sqlite.env
if grep -q '^POSTGRES_PASSWORD=[0-9a-f]\{64\}$' choices/sqlite.env; then echo 'SQLite generated a PostgreSQL password' >&2; exit 1; fi
cp choices/.env.example choices/postgres.env
sed -i 's/^GACHIPAD_DB=sqlite/GACHIPAD_DB=postgres/; s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=mdns/' choices/postgres.env
(cd choices && ./generate-secrets.sh postgres.env >postgres.log)
grep -qx 'GACHIPAD_DB=postgres' choices/postgres.env
grep -qx 'COMPOSE_PROFILES=mdns,postgres' choices/postgres.env
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{64}$' choices/postgres.env
pg_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' choices/postgres.env)"
if grep -qF "$pg_password" choices/postgres.log; then echo 'PostgreSQL password was printed' >&2; exit 1; fi
cp choices/.env.example choices/mongodb.env
sed -i 's/^GACHIPAD_DB=sqlite/GACHIPAD_DB=mongodb/; s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=mdns/' choices/mongodb.env
(cd choices && ./generate-secrets.sh mongodb.env >/dev/null)
grep -qx 'GACHIPAD_DB=mongodb' choices/mongodb.env
grep -qx 'COMPOSE_PROFILES=mdns,mongodb' choices/mongodb.env
cat >choices/legacy11.env <<'ENV'
MONGO_PASSWORD=old-root
MONGO_APP_PASSWORD=old-app
MONGO_DATABASE=codesh
COMPOSE_PROFILES=mdns
ENV
(cd choices && ./generate-secrets.sh legacy11.env >/dev/null)
grep -qx 'GACHIPAD_DB=mongodb' choices/legacy11.env
grep -qx 'COMPOSE_PROFILES=mdns,mongodb' choices/legacy11.env
# The old renamed updater appends GACHIPAD_DB=sqlite from the new template before
# invoking the staged helper. Its original live env must still pin MongoDB.
mkdir -p choices/live/state choices/staged
cp choices/legacy11.env choices/live/.env
sed -i '/^GACHIPAD_DB=/d; /^GACHIPAD_DATABASE_URL=/d' choices/live/.env
cp generate-secrets.sh .env.example choices/staged/
cp choices/live/.env choices/staged/.env
printf 'GACHIPAD_DB=sqlite\n' >>choices/staged/.env
(cd choices/staged && GACHIPAD_LOCK_PATH="$WORK/choices/live/state/install.lock" ./generate-secrets.sh >/dev/null)
grep -qx 'GACHIPAD_DB=mongodb' choices/staged/.env
grep -qx 'COMPOSE_PROFILES=mdns,mongodb' choices/staged/.env
if (cd choices/staged && GACHIPAD_LOCK_PATH="$WORK/choices/live/state/install.lock" GACHIPAD_DB=postgres ./generate-secrets.sh >refusal.log 2>&1); then
  echo 'legacy staged helper accepted a backend switch' >&2; exit 1
fi
grep -q 'future copy tool' choices/staged/refusal.log
cp choices/.env.example choices/external.env
url='mysql://user:p%40ss@db.local/gachipad?ssl=true&charset=utf8mb4'
(cd choices && DATABASE_URL="$url" ./generate-secrets.sh external.env >external.log)
grep -qx 'GACHIPAD_DB=external' choices/external.env
grep -qxF "DATABASE_URL='$url'" choices/external.env
grep -q '^GACHIPAD_DATABASE_URL=$' choices/external.env
if grep -qF 'p%40ss' choices/external.log; then echo 'external URL was printed' >&2; exit 1; fi
# Empty non-legacy settings must not become MongoDB after compatibility secrets are filled.
: >choices/empty.env
(cd choices && ./generate-secrets.sh empty.env >/dev/null)
grep -qx 'GACHIPAD_DB=sqlite' choices/empty.env
cp choices/.env.example choices/invalid-url.env
if (cd choices && DATABASE_URL='file:///private/secret' ./generate-secrets.sh invalid-url.env >invalid.log 2>&1); then
  echo 'unsupported URL scheme accepted' >&2; exit 1
fi
grep -q 'unsupported scheme' choices/invalid.log
if grep -q 'private/secret' choices/invalid.log; then echo 'invalid URL was printed' >&2; exit 1; fi
rm -rf choices
# install.sh must not start an empty project beside the volumes of a 1.0.x installation.
mkdir -p inst bin
cp "$ROOT/install.sh" "$ROOT/lib.sh" "$ROOT/generate-secrets.sh" "$ROOT/.env.example" inst/
printf '1.0.2\n' >inst/VERSION
printf 'images\n' >inst/images.tar
(cd inst && sha256sum images.tar VERSION >SHA256SUMS)
cat >bin/docker <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$1 ${2:-}" in
  "volume ls") printf '%s\n' ${FAKE_VOLUMES:-} ;;
  "load -i") exit 1 ;; # reached only after the legacy-volume check
esac
exit 0
DOCKER
chmod +x bin/docker
export PATH="$WORK/bin:$PATH" DOCKER_CALLS="$WORK/docker.calls"
: >"$DOCKER_CALLS"
if FAKE_VOLUMES=codesh_mongo-data bash inst/install.sh >install.log 2>&1; then exit 1; fi
grep -q 'codesh 1.0.x installation' install.log
if grep -q '^load ' "$DOCKER_CALLS"; then echo "loaded images before the volume check" >&2; exit 1; fi
if [ -e inst/.env ]; then echo ".env created beside legacy volumes" >&2; exit 1; fi
for opt in COMPOSE_PROJECT_NAME=other GACHIPAD_NEW_INSTALL=1; do
  : >"$DOCKER_CALLS"
  if env "$opt" FAKE_VOLUMES=codesh_mongo-data bash inst/install.sh >install.log 2>&1; then exit 1; fi
  grep -q '^load ' "$DOCKER_CALLS" || { echo "$opt did not pass the volume check" >&2; exit 1; }
done
: >"$DOCKER_CALLS"
FAKE_VOLUMES=other_volume bash inst/install.sh >install.log 2>&1 || true
grep -q '^load ' "$DOCKER_CALLS" || { echo "unrelated volumes blocked the install" >&2; exit 1; }
rm -rf inst
mkdir -p release/dist
for name in deploy-1.0.2 1.0.2-linux-amd64 1.0.2-linux-arm64 web-sourcemaps-1.0.2; do
  printf 'fixture %s\n' "$name" >"release/dist/gachipad-$name.tar.gz"
done
# Execute the release workflow's exact compatibility step against small local fixtures.
sed -n '/for asset in dist\/gachipad-/,/^[[:space:]]*done$/p' "$ROOT/../.github/workflows/release.yml" >release/aliases.sh
(cd release && bash aliases.sh)
(cd release/dist && sha256sum -c codesh-*.sha256)
echo 'database selection: SQLite default, PostgreSQL secret/profile, MongoDB legacy/profile, external URL preservation and scheme rejection passed'
echo 'rename migration: scenarios passed (legacy locations, secrets, idempotence, commented-out legacy lines, offline registry, custom/fresh names, HTTPS alias only with tls internal, trimmed .env)'
echo 'release aliases: deploy, amd64, arm64 and source maps match their new assets and checksums'
