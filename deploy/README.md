# Deploying codesh

One Docker host runs the whole stack (docs/ARCHITECTURE.md §1): **Caddy** (static web app, `/api`, `/collab`), **api**, **collab** (one or more), **MongoDB 8** and **Valkey 8**. Only Caddy publishes ports. Everything needed at runtime is in the images: no CDN, font service or other outside request.

## From the repository

```sh
cd deploy
cp .env.example .env && ./generate-secrets.sh     # once; .env stays on the host
docker compose up -d --build                      # builds api, collab and the Caddy image (with apps/web/dist)
curl http://localhost/healthz
```

`.env.example` documents every variable. Secrets are random hex written by `generate-secrets.sh`; it never overwrites a value that is set. `MONGO_PASSWORD` only seeds a new volume: change it later with `mongosh`, not by editing `.env`.

### Windows host

Docker Desktop with its WSL2 backend and Docker Compose v2 can run the same stack. PowerShell
operators can use `generate-secrets.ps1`; for offline bundles use `install.ps1`, `backup.ps1`,
`restore.ps1` and `upgrade.ps1`. Create or keep `tls/` beside `docker-compose.yml`; the Compose
bind mount resolves it from the Compose file location, and Windows file ACLs replace the Unix
`chmod 600` step. Leave the optional `mdns` profile disabled on Docker Desktop because its
host-network sidecar is not supported there. See [Windows에서 운영하기](../docs/OPERATIONS.md#13-windows에서-운영하기)
for setup, firewall and phone access details.

## Edge (Caddy)

- `/` and unknown paths serve `index.html` (SPA fallback, `no-cache`); `/assets/*` is hashed build output (`immutable`, one year).
- `/api/*` is proxied with `flush_interval -1`, so SSE events leave immediately.
- `/collab` is proxied to every `collab` replica (`dynamic a` over the compose service name) with `lb_policy query doc`: one document normally lives on one instance. Replicas that fail `/healthz` are skipped.
- `/metrics/api` and `/metrics/collab` expose Prometheus metrics to private address ranges only. With several collab replicas `/metrics/collab` answers from one of them; scrape the containers directly for per-instance numbers.
- HTTPS: set `SITE_ADDRESS=codesh.corp` and add a `tls` directive in `deploy/tls/*.caddy` (see `tls/README.md`).
- Clients behind Caddy: the API trusts `X-Forwarded-For` only from `TRUST_PROXY` (default: the compose network), so rate limits, PIN counters and the nearby network group use the real client address.

## More collab instances

```sh
docker compose up -d --scale collab=3      # or COLLAB_REPLICAS=3 in .env
```

Instances coordinate through Valkey (document locks, `@hocuspocus/extension-redis`). Each replica's id is its container host name.

## codesh.local (mDNS)

`COMPOSE_PROFILES=mdns` in `.env` starts `mdns/`, a small sidecar (`bonjour-service`, MIT) on the host network that answers for `MDNS_HOSTNAME` (default `codesh.local`). Linux hosts only; set `MDNS_IP` when the host has several addresses. `apps/api` is not involved.

## Offline bundle

On a machine with internet and docker (for example `scripts/box deploy/bundle.sh`):

```sh
deploy/bundle.sh [version]        # -> deploy/dist/codesh-<version>.tar.gz (+ .sha256)
```

The archive holds all images (`docker save`), `docker-compose.yml` without build sections, `.env.example` and the scripts. On the target host (docker + compose plugin, no internet):

```sh
tar xzf codesh-<version>.tar.gz && cd codesh-<version>
PUBLIC_URL=http://codesh.corp ./install.sh      # loads images, writes .env with new secrets, starts, waits for /healthz
./backup.sh                                     # mongodump -> ./backups/codesh-<time>.archive.gz
./restore.sh backups/codesh-<time>.archive.gz   # stops api+collab, mongorestore --drop, starts them
./upgrade.sh ../codesh-<newer>.tar.gz           # backup, load images, keep .env, up -d, wait for /healthz
```

Valkey holds join codes, presence and caches only; it is not part of the backup.

On Windows, extract with `tar.exe -xzf codesh-<version>.tar.gz`, open PowerShell in the extracted
folder, then run `./install.ps1`. The PowerShell scripts are included in each bundle.

## Load test

`pnpm load -- --url http://codesh.corp --shares 100 --writers 5 --viewers 20 --duration 60` (see `scripts/load`). One machine is one client IP: raise `RATE_LIMIT_*` in `.env` for big runs.

## Notes

- `apps/api` and `apps/collab` have no build step; the images run the TypeScript sources with `tsx` (installed beside the app). `NODE_ENV=production` makes both refuse to start with weak secrets.
- Containers run as non-root where the image allows it (api, collab, Valkey, MongoDB drop privileges), with a read-only root filesystem for api and collab.
- Logs are capped at 3 x 10 MB per container.
