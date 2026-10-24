#!/usr/bin/env bash
# Regression probes for checksums: scripts/box 'bash deploy/security-scripts.test.sh'
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/install" "$fixture/bin"
cat >"$fixture/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_CALLS"
[ "$1" = compose ] && [ "${2:-}" = version ] && exit 0
exit 0
DOCKER
chmod +x "$fixture/bin/docker"
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
