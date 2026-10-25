# HTTPS on a private network

Choose a stable hostname that resolves to this Docker host, for example `gachipad.local`. All runtime assets are local. Caddy's internal CA works without internet access:

```sh
cp tls/internal.caddy.example tls/local.caddy
# In .env: SITE_ADDRESS=gachipad.local and PUBLIC_URL=https://gachipad.local
docker compose up -d caddy api
```

The example enables `tls internal` and HSTS for this HTTPS site only. Keep port 80 for Caddy's redirect. On a nonstandard HTTPS port include that port in `SITE_ADDRESS` and `PUBLIC_URL`, and map the same container port. Never add HSTS to the plain HTTP configuration.

Export **only** the public root certificate after Caddy starts:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./gachipad-root.crt
openssl x509 -in gachipad-root.crt -noout -fingerprint -sha256
```

Verify its fingerprint with the operator over a trusted channel before installing it. Each client must trust this CA:

- macOS: import into the System keychain and set the certificate to Always Trust, or run `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain gachipad-root.crt`.
- Windows: `certutil -user -addstore Root gachipad-root.crt` for the current user; centrally managed devices may require administrator deployment.
- Debian/Ubuntu: copy it to `/usr/local/share/ca-certificates/gachipad.crt` and run `sudo update-ca-certificates`. Firefox may require importing it into its own Authorities store or enabling operating-system root trust.
- Phones/tablets: install the root through the device's certificate/profile settings and enable root trust where required.

Protect and back up the `caddy-data` volume: its CA private key can mint trusted certificates. Never distribute `root.key`. For a certificate from your own CA, create `tls/local.caddy` containing:

```caddy
tls /etc/caddy/tls/gachipad.crt /etc/caddy/tls/gachipad.key
header Strict-Transport-Security "max-age=31536000"
```

Set key permissions to `0600` on the host. Private material in this directory is ignored by Git; only this guide and `*.example` files are tracked.

When using custom operator certificates (or upgrading an existing 1.0.x installation where `SITE_ADDRESS` was `codesh.local`): Caddy adds the `gachipad.local` alias automatically only when `tls/*.caddy` specifies `tls internal`. With an operator-provided certificate (`tls <cert> <key>`), you must issue a certificate that includes `gachipad.local` in Subject Alternative Names (SAN), and then set `SITE_ALIASES=, gachipad.local` (with the required leading comma and space) in `.env`.

Plain HTTP stays supported with `SITE_ADDRESS=:80`. On HTTP, anyone able to observe or alter network traffic can read or steal session cookies, administrator tokens, PINs, edit keys, document content and WebSocket tokens. SameSite and signed cookies do not encrypt traffic. A private network alone does not provide confidentiality. Set `PUBLIC_URL` to the actual HTTPS origin to enable Secure session cookies; HTTPS is recommended before handling sensitive content.
