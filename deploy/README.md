# Deploying codesh

One Docker host runs the whole stack (docs/ARCHITECTURE.md §1): **Caddy** (static web app, `/api`, `/collab`), **api**, **collab** (one or more), **MongoDB 8** and **Valkey 8**. Only Caddy publishes ports. Everything needed at runtime is in the images: no CDN, font service or other outside request.

## Images

Releases publish `ghcr.io/kim0040/codesh-web` (Caddy with the web app), `codesh-api`, `codesh-collab` and `codesh-mdns` for linux/amd64 and linux/arm64, tagged `X.Y.Z`, `X.Y`, `X` and `latest`. They are public: pulling needs no login. `docker-compose.yml` names `${CODESH_REGISTRY}/codesh-*:${CODESH_VERSION}`; set `CODESH_REGISTRY` to a mirror that keeps the digests if the host cannot reach ghcr.io.

## From the repository

```sh
cd deploy
cp .env.example .env && ./generate-secrets.sh     # once; .env stays on the host
docker compose pull && docker compose up -d       # the release CODESH_VERSION from GHCR
docker compose up -d --build                      # or: build api, collab and the Caddy image from these sources
curl http://localhost/healthz
```

`docker compose build` builds the images from the checkout and tags them with `CODESH_VERSION`, which must equal the root `package.json` version (the Dockerfiles check); `docker compose pull` fetches the released images of that version instead. After `git pull`, build again.

`.env.example` documents every variable. Secrets are random hex written by `generate-secrets.sh`; it never overwrites a value that is set. `MONGO_PASSWORD` only seeds a new volume: change it later with `mongosh`, not by editing `.env`.

## Edge (Caddy)

- `/` and unknown paths serve `index.html` (SPA fallback, `no-cache`); `/assets/*` is hashed build output (`immutable`, one year).
- `/api/*` is proxied with `flush_interval -1`, so SSE events leave immediately.
- `/collab` is proxied to every `collab` replica (`dynamic a` over the compose service name) with `lb_policy query doc`: one document normally lives on one instance. Replicas that fail `/healthz` are skipped.
- `/metrics/api` and `/metrics/collab` expose Prometheus metrics to loopback and the dedicated compose subnet only. With several collab replicas `/metrics/collab` answers from one of them; scrape the containers directly for per-instance numbers.
- HTTPS: set `SITE_ADDRESS=codesh.local`, `PUBLIC_URL=https://codesh.local` and copy `tls/internal.caddy.example` to `tls/local.caddy` (see `tls/README.md`).
- A host name in `SITE_ADDRESS` needs a `tls/*.caddy` file with a `tls ...` line (`tls internal`, or `tls <cert> <key>`). Without one Caddy's automatic HTTPS contacts a public ACME CA (Let's Encrypt/ZeroSSL), which fails on a network without internet and is an outside request. `:80` and bare IP addresses need no `tls` line.
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
deploy/bundle.sh [version]        # -> deploy/dist/codesh-<version>.tar.gz and codesh-deploy-<version>.tar.gz (+ .sha256)
BUNDLE_SOURCE=registry BUNDLE_SUFFIX=-linux-amd64 deploy/bundle.sh 1.2.3   # from the released images (release.yml)
```

Releases attach these bundles as `codesh-<version>-linux-amd64.tar.gz` and `-linux-arm64.tar.gz`, so building one is only needed for unreleased sources. `codesh-deploy-<version>.tar.gz` is the same without images, for `update.sh`; with `BUNDLE_SOURCE=registry` both contain `IMAGES`, the digest of each released image. The archive includes a verified content checksum manifest and holds all images (`docker save`), `docker-compose.yml` without build sections, `.env.example`, the scripts, and `LICENSE` and `THIRD_PARTY_NOTICES.md`. `images.tar` contains the unmodified official `mongo` (SSPL), `valkey`, `caddy` and `node` base images next to the codesh images; their licences and sources are listed in `THIRD_PARTY_NOTICES.md`. On the target host (docker + compose plugin, no internet):

```sh
sha256sum -c codesh-<version>.tar.gz.sha256     # compare the value with one received over a trusted channel
tar xzf codesh-<version>.tar.gz && cd codesh-<version>
PUBLIC_URL=http://codesh.corp ./install.sh      # loads images, writes .env with new secrets, starts, waits for /healthz
./backup.sh                                     # mongodump -> ./backups/codesh-<time>.archive.gz
./restore.sh backups/codesh-<time>.archive.gz   # stops api+collab, mongorestore --drop, starts them
./upgrade.sh ../codesh-<newer>.tar.gz           # checksums, backup, load images, keep .env, up -d, wait for /healthz
```

`install.sh` checks `SHA256SUMS` inside the bundle; `upgrade.sh` needs `<bundle>.sha256` next to the bundle and checks it before extracting, then `SHA256SUMS` before loading images. A checksum is not a signature: it only detects a changed or damaged bundle when the value itself arrives over a trusted channel.

api and collab connect as `codesh_app` (readWrite on database `codesh` only). The one-shot service `mongo-users` creates that user, or resets its password and role, as root on every start, so an installation from before this user existed switches over on its next upgrade without a manual step. Upgrading from such a version runs the old `upgrade.sh`: it finishes, then prints `tmp: unbound variable` and exits 1 because of a bug in its cleanup trap (fixed since), and leaves the extracted bundle in `/tmp/tmp.*`; check `docker compose ps` and remove that directory. `deploy/verify-deploy.sh` runs the whole path (fresh install, backup, restore, refused and accepted upgrades, HTTPS, an old installation) on a docker host.

## Updates

```sh
./update.sh --check                                  # installed vs newest release; changes nothing
./update.sh [--version X.Y.Z] [--yes] [--allow-major]  # online: checksums, backup, pull, digests, up, /healthz + /readyz, rollback on failure
./update.sh --bundle ../codesh-<v>-linux-amd64.tar.gz  # offline: runs upgrade.sh and records the result
sudo ./update.sh --enable-auto --at 04:00 --policy patch   # daily automatic updates (systemd timer, or cron); --disable-auto
```

`update.sh` works in an installed bundle, not in this repository. It writes `state/update.json` (shown in the admin console: `./state` is mounted read-only into api) and `state/update.log`; no container gets the Docker socket. Settings: `UPDATE_REPO`, `UPDATE_CHANNEL` and `UPDATE_HEALTH_TIMEOUT` (180 s) from the environment or `.env`. The API's own release check is `UPDATE_CHECK` (on). Details, what is sent and the costs: `docs/OPERATIONS.md` §15. `deploy/update.test.sh` tests the script with fakes; `deploy/verify-update.sh` runs a real update and rollback on a docker host with a local registry.

Valkey holds join codes, presence, grants, network bans and quota counters; it is not part of the Mongo backup. Keep its volume and do not flush it in production. See the operator security checklist in `docs/OPERATIONS.md`.

## Load test

`pnpm load -- --url http://codesh.corp --shares 100 --writers 5 --viewers 20 --duration 60` (see `scripts/load`). One machine is one client IP: raise `RATE_LIMIT_*` in `.env` for big runs.

## Notes

- `apps/api` and `apps/collab` have no build step; the images run the TypeScript sources with `tsx` (installed beside the app). `NODE_ENV=production` makes both refuse to start with weak secrets.
- Containers run as non-root where the image allows it (api, collab, Valkey, MongoDB drop privileges), with a read-only root filesystem for api and collab.
- Logs are capped at 3 x 10 MB per container.

Plain HTTP exposes document content and session/admin/PIN/edit/collab credentials to traffic observers. HTTPS setup and client CA trust instructions are in [tls/README.md](tls/README.md). Keep backups private and retain both the Mongo backup and protected Caddy CA volume.
