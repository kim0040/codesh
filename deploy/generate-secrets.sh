#!/usr/bin/env bash
# Fills the empty secrets of an env file with random values; values that are already set stay.
#
#   ./generate-secrets.sh            # creates .env from .env.example if missing, then fills it
#   ./generate-secrets.sh path/.env  # fills that file
set -euo pipefail
umask 077

cd "$(dirname "$0")"
FILE="${1:-.env}"
SECRETS=(SESSION_SECRET COLLAB_SECRET ADMIN_TOKEN MONGO_PASSWORD MONGO_APP_PASSWORD VALKEY_PASSWORD)

if [ ! -f "$FILE" ]; then
  [ -f .env.example ] || { echo "generate-secrets: $FILE and .env.example are missing" >&2; exit 1; }
  cp .env.example "$FILE"
fi

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

TMP="$(mktemp "$FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$FILE" "$TMP"
filled=()
for name in "${SECRETS[@]}"; do
  if grep -Eq "^${name}=[[:space:]]*$" "$TMP"; then
    value="$(random_hex)"
    # Hex has no characters that sed or the shell treat specially.
    sed "s|^${name}=.*|${name}=${value}|" "$TMP" >"$TMP.next" && mv "$TMP.next" "$TMP"
    filled+=("$name")
  elif ! grep -Eq "^${name}=" "$TMP"; then
    printf '%s=%s\n' "$name" "$(random_hex)" >>"$TMP"
    filled+=("$name")
  fi
done
cat "$TMP" >"$FILE"
chmod 600 "$FILE"
# The legacy upgrader calls this helper before starting Compose, but does not copy state/.
# Create the status mount as the operator so Docker cannot create a root-owned directory.
mkdir -p state && chmod 755 state
if [ "${#filled[@]}" -gt 0 ]; then
  echo "generate-secrets: wrote ${filled[*]} to $FILE"
else
  echo "generate-secrets: $FILE already has all secrets"
fi
