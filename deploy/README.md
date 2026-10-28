# Deploying gachipad

One Docker host runs the whole stack (docs/ARCHITECTURE.md §1): **Caddy** (static web app, `/api`, `/collab`), **api**, **collab** (one or more), the selected database (SQLite by default, bundled PostgreSQL 17, bundled MongoDB 8, or an external database), and **Valkey 8**. Only Caddy publishes ports. Everything needed at runtime is in the images: no CDN, font service or other outside request.

## Images

Releases publish `ghcr.io/kim0040/gachipad-web` (Caddy with the web app), `gachipad-api`, `gachipad-collab` and `gachipad-mdns` for linux/amd64 and linux/arm64, tagged `X.Y.Z`, `X.Y`, `X` and `latest`. They are public: pulling needs no login. `docker-compose.yml` names `${GACHIPAD_REGISTRY}/gachipad-*:${GACHIPAD_VERSION}`; set `GACHIPAD_REGISTRY` to a mirror that keeps the digests if the host cannot reach ghcr.io.

## From the repository

```sh
cd deploy
cp .env.example .env && ./generate-secrets.sh     # once; .env stays on the host
docker compose pull && docker compose up -d       # the release GACHIPAD_VERSION from GHCR
docker compose up -d --build                      # or: build api, collab and the Caddy image from these sources
curl http://localhost/healthz
```

`docker compose build` builds the images from the checkout and tags them with `GACHIPAD_VERSION`, which must equal the root `package.json` version (the Dockerfiles check); `docker compose pull` fetches the released images of that version instead. After `git pull`, build again.

`.env.example` documents every variable. Secrets are random hex written by `generate-secrets.sh`; it never overwrites a value that is set. Always run `./generate-secrets.sh .env` after changing database passwords. `MONGO_PASSWORD` and `POSTGRES_PASSWORD` only seed a new volume: rotate the database role password inside the database server as well when changing existing credentials.

## Database choices

gachipad supports multiple database backends, selected during installation or configured via `.env`:

- **SQLite** (default for new installs): Stored in `/data/gachipad.db` on the shared `gachipad-data` volume in WAL mode. Requires no server setup, external credentials, or extra containers. Recommended for single-host deployments. Budget at least twice the uncompressed database size as free operational disk headroom for snapshots and restores.
- **Bundled PostgreSQL**: Runs `postgres:17.11-alpine` under Compose profile `postgres`. Multi-replica collab scale-out ready. Password generated automatically.
- **Bundled MongoDB**: Runs `mongo:8.0.34` under Compose profile `mongodb`. Upgraded 1.0.x installations retain MongoDB automatically without data migration. On Linux kernels 6.19 up to 7.0.13 (and Ubuntu kernels reported as `7.0.0-NN` by `uname -r`), MongoDB 8.0.34 deliberately refuses to start to avoid crashes and data corruption (`cat /proc/version_signature` shows the upstream version). Operators can boot a kernel older than 6.19, migrate data to SQLite or PostgreSQL with `migrate-db.sh` while MongoDB can start, or choose SQLite or PostgreSQL for new installs (docs/OPERATIONS.md §13.2). MongoDB 8.0.35 recognises Ubuntu kernels and will be adopted in a patch release once published.
- **External database**: Connect to external PostgreSQL, MySQL, MariaDB, or MongoDB via `DATABASE_URL` (`GACHIPAD_DB=external`). MySQL and MariaDB are supported as external servers only; bundled images are not provided for them.
- **Valkey**: Required for every database choice (document locks, presence, rate limits, join codes).

## Installation with --db

```sh
./install.sh [--db sqlite|postgres|mongodb|external] [--database-url URL]
```

- **Interactive detection**: On a TTY, the installer inventories local database ports (5432, 3306, 27017), running containers, installed client CLI tools, and available memory, prompting for the backend with SQLite as the recommended default.
- **Non-interactive installs**: Default to SQLite unless `--db` or `DATABASE_URL` is passed.
- **External database connection**: If `--db external` is selected without a URL on a TTY, a hidden input prompt asks for `DATABASE_URL`. Multiline values are rejected, and URLs are stored single-quoted in `.env` to preserve special characters (`$`, `#`, spaces).
- **Backend guard**: Refuses switching if non-empty data volumes or a recorded marker from another backend exist (`database backend change refused; use ./migrate-db.sh to copy data and switch backends`).

## Backups and restores

- **Backup (`./backup.sh [dir]`)**: Default directory `./backups`. Backups are written with `0600` permissions into a `0700` directory.
  - **SQLite**: Online `VACUUM INTO` snapshot inside the data volume, streamed directly to gzip. No live WAL lock is copied.
  - **PostgreSQL**: `pg_dump --format=custom` wrapped in gzip.
  - **MongoDB**: `mongodump` compressed archive.
  - **External**: Creates no local archive. Operators must use the external database's native tools and set `GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1` before updates or maintenance.
- **Restore (`./restore.sh <archive.gz> [--yes]`)**:
  - Validates archive integrity and takes a safety backup of the existing database before stopping writers and replacing data.
  - **SQLite**: Verifies SQLite 3 header and `PRAGMA integrity_check`, requires source size plus 20% (at least 64 MiB extra) disk headroom, writes to `<dest>.restore`, removes stale `-wal`/`-shm`, and atomically renames the restored file.
  - **PostgreSQL**: Verifies archive TOC, restores into a unique temporary database (`gp_restore_*`) with `--single-transaction`, and atomically swaps live and staged databases in a single transaction on `template1`. Drops the old database only after commit. On failure, the live database is left unchanged and the safety backup path is displayed.
  - **MongoDB**: Runs `mongorestore --drop` after dry-run validation.
  - **External**: Local restore refuses external databases and directs operators to the external server's restore tools.

## Database migration (migrate-db.sh)

`migrate-db.sh` migrates data offline between any supported database backends.

```sh
./migrate-db.sh --to sqlite|postgres|mongodb|external [--window-minutes N] [--yes]
```

- **Execution flow**:
  1. Acquires the installation lock (`state/install.lock`) and validates prerequisites.
  2. Creates a private staging directory (`.env.migrate-db.*`) and records the transaction marker (`state/transaction`). Live `.env` stays untouched.
  3. Preflight check (before downtime): Verifies bundle tools, destination volume emptiness, source schema, and disk space across local `/data`, `backups`, and target volume (source size plus 20%, at least 64 MiB extra).
  4. Quiescence & downtime: Stops Caddy, API, and collab writers. Downtime begins here.
  5. Checkpoint: If the source is SQLite, folds committed WAL pages into the main file via `PRAGMA wal_checkpoint(TRUNCATE)` and verifies absence of sidecars.
  6. Target startup & quiescent backup: Starts the target backend and takes a quiescent backup of the source.
  7. Offline copy: Runs the API image's `copy-db` CLI. Skips diagnostics and records expiring within `--window-minutes`. Verifies SHA-256 data digests.
  8. Atomic activation: Swaps `.env`, updates `state/database-kind`, starts target services, verifies health, and reopens ingress.
  9. Data retention: Previous database volumes and backups are retained for operator verification and never deleted automatically.
- **Refusal and failure handling**:
  - Non-empty destination: `migrate-db: destination was not modified: refused ... use an empty destination.` Clear or drop destination before retrying.
  - Source refusal: `migrate-db: source refused ... Fix the source and retry; do not delete -wal/-shm files, which can hold committed data.`
  - Unwritten failure: `migrate-db: destination was not modified; nothing was copied.`
  - Partial copy: `migrate-db: destination may hold a partial copy; inspect and clear it before retrying.`
  - Incomplete recovery: Retains staging snapshots and prints manual recovery commands.
- **Tuning `--window-minutes`**:
  - Window defaults to 15 minutes (or `GACHIPAD_COPY_WINDOW_MINUTES`). The copy deadline is `window - 5` minutes.
  - Measured throughput: ~40 MB/s into PostgreSQL, 85–106 MB/s into SQLite for upload-heavy data (~4–7 MB/s for record-heavy data).
  - Minimum window formula: `size in MB / throughput in MB/s / 60 * 2 + 5` minutes.
- **Source stability requirement**:
  - SQLite source paths and symlinks must remain completely unchanged and writers stopped during the copy. Renaming, moving, or relinking the source path or directories causes immediate failure (`exit 1`).
- **One-time extraction for 1.0.1 upgrades**:
  - Installations updated from 1.0.1 lack `migrate-db.sh` due to the older updater's whitelist. Extract it once from the verified 1.1.0 release bundle:
    ```sh
    sha256sum -c gachipad-deploy-1.1.0.tar.gz.sha256 && \
    bundle_root="$(tar -tzf gachipad-deploy-1.1.0.tar.gz | cut -d / -f 1 | sort -u)" && \
    tar -xOf gachipad-deploy-1.1.0.tar.gz "$bundle_root/migrate-db.sh" >migrate-db.sh.new && \
    chmod 700 migrate-db.sh.new && mv migrate-db.sh.new migrate-db.sh && ./migrate-db.sh --help
    ```
- **Requirements**: Docker Compose 2.20 or newer is required.

## Admin configuration and access hardening

- **HTTPS required**: The admin console sends its bearer token with every request. Plain HTTP on non-loopback hosts triggers a persistent cleartext warning. Configure HTTPS in production.
- **Admin token and rotation**: Generate an admin token with `openssl rand -hex 32`. In production, tokens shorter than 32 characters are rejected at startup. To rotate the token: update `ADMIN_TOKEN` in `.env`, run `docker compose up -d api`, and log in again with the new token.
- **CIDR restriction (`ADMIN_ALLOW_CIDR`)**: Restrict `/api/admin/*` and the admin console to trusted network ranges. IPv4 and IPv6 are evaluated independently, so list both families if clients use both (e.g. `ADMIN_ALLOW_CIDR=10.0.0.0/8,fd00::/8`).
- **`TRUST_PROXY` requirement**: When running behind Caddy or a reverse proxy, set `TRUST_PROXY` to the proxy's exact subnet. If `TRUST_PROXY` is empty or incorrect, the proxy's address is evaluated instead of the real client IP, defeating CIDR restrictions and IP rate limits.
- **Global guess budget**: Failed admin logins share an atomic Valkey token bucket across API replicas: capacity 100, refill 100 per 10 minutes. When exhausted, token comparisons pause for 30 seconds with a `429` and `Retry-After` header. Correct tokens and addresses permitted by `ADMIN_ALLOW_CIDR` bypass the pause. Fails closed if Valkey is unavailable.

## Collab rate limit and participant permissions

- **Collab update rate limiting**: Each collaborative WebSocket connection is protected by a token bucket (burst 200 updates, sustained refill 50/s). Exceeding this closes the connection with code 4429 (`Document update rate exceeded`). Normal typing and large single pastes (counted as 1 update) do not exceed the limit.
- **Participant permissions**: Owners can grant editors permission to rename the share (`allowParticipantRename`), add/rename/delete files (`allowParticipantFiles`), or change file languages (`allowParticipantLanguage`). All three default to `false` for new and existing shares. Old records omitting these fields default safely to `false` without data migration. Unauthorized operations are refused by the server, and unsent text is kept in client tab memory for recovery.

## Diagnostics and symbolication

- **Diagnostics export**: Bounded operational diagnostics record errors, connectivity, and performance metrics (capped at 500 groups, 256 KB, 14-day retention). No telemetry is sent automatically. Users can export client diagnostics from **Settings → Diagnostics → Export**; operators can export a server bundle from **Admin Console → Diagnostics → Export** (`GET /api/admin/diagnostics/export`).
- **Release source maps**: Web source maps are stripped from the runtime container image and published as a GitHub release asset (`gachipad-web-sourcemaps-<version>.tar.gz`). To symbolicate a client export:
  ```sh
  tar xzf gachipad-web-sourcemaps-<version>.tar.gz -C /tmp/sourcemaps
  node scripts/symbolicate.mjs client-diagnostics.json /tmp/sourcemaps
  ```

## Edge (Caddy)

- `/` and unknown paths serve `index.html` (SPA fallback, `no-cache`); `/assets/*` is hashed build output (`immutable`, one year).
- `/api/*` is proxied with `flush_interval -1`, so SSE events leave immediately.
- `/collab` is proxied to every `collab` replica (`dynamic a` over the compose service name) with `lb_policy query doc`: one document normally lives on one instance. Replicas that fail `/healthz` are skipped.
- `/metrics/api` and `/metrics/collab` expose Prometheus metrics to loopback and the dedicated compose subnet only. With several collab replicas `/metrics/collab` answers from one of them; scrape the containers directly for per-instance numbers.
- HTTPS: set `SITE_ADDRESS=gachipad.local`, `PUBLIC_URL=https://gachipad.local` and copy `tls/internal.caddy.example` to `tls/local.caddy` (see `tls/README.md`).
- A host name in `SITE_ADDRESS` needs a `tls/*.caddy` file with a `tls ...` line (`tls internal`, or `tls <cert> <key>`). Without one Caddy's automatic HTTPS contacts a public ACME CA (Let's Encrypt/ZeroSSL), which fails on a network without internet and is an outside request. `:80` and bare IP addresses need no `tls` line.
- Clients behind Caddy: the API trusts `X-Forwarded-For` only from `TRUST_PROXY` (default: the compose network), so rate limits, PIN counters and the nearby network group use the real client address.

## More collab instances

```sh
docker compose up -d --scale collab=3      # or COLLAB_REPLICAS=3 in .env
```

Instances coordinate through Valkey (document locks, `@hocuspocus/extension-redis`). Each replica's id is its container host name.

## gachipad.local (mDNS)

`COMPOSE_PROFILES=mdns` in `.env` starts `mdns/`, a small sidecar (`bonjour-service`, MIT) on the host network that answers for `MDNS_HOSTNAME` (default `gachipad.local`). Linux hosts only; set `MDNS_IP` when the host has several addresses. `apps/api` is not involved.

## Offline bundle

On a machine with internet and docker:

```sh
deploy/bundle.sh [version]        # -> deploy/dist/gachipad-<version>.tar.gz and gachipad-deploy-<version>.tar.gz (+ .sha256)
BUNDLE_SOURCE=registry BUNDLE_SUFFIX=-linux-amd64 deploy/bundle.sh 1.2.3   # from the released images (release.yml)
```

Releases attach these bundles as `gachipad-<version>-linux-amd64.tar.gz` and `-linux-arm64.tar.gz`, so building one is only needed for unreleased sources. `gachipad-deploy-<version>.tar.gz` is the same without images, for `update.sh`; with `BUNDLE_SOURCE=registry` both contain `IMAGES`, the digest of each released image. The archive includes a verified content checksum manifest and holds all images (`docker save`), `docker-compose.yml` without build sections, `.env.example`, the scripts, and `LICENSE` and `THIRD_PARTY_NOTICES.md`. `images.tar` contains the unmodified official `mongo` (SSPL), `postgres` (PostgreSQL Licence), `valkey`, `caddy` and `node` base images next to the gachipad images; their licences and sources are listed in `THIRD_PARTY_NOTICES.md`. On the target host (docker + compose plugin, no internet):

```sh
sha256sum --ignore-missing -c SHA256SUMS       # download SHA256SUMS with the release bundle; a local .sha256 also works
tar xzf gachipad-<version>.tar.gz && cd gachipad-<version>       # release files are named gachipad-<version>-linux-amd64 (or -arm64)
PUBLIC_URL=http://gachipad.local ./install.sh [--db sqlite|postgres|mongodb|external]      # loads images, writes .env with new secrets, starts, waits for /healthz
./backup.sh                                     # database backup -> ./backups/gachipad-<time>.archive.gz
./restore.sh backups/gachipad-<time>.archive.gz   # stops ingress/writers, replaces DB, verifies apps, opens ingress
./migrate-db.sh --to <backend>                   # offline migration between database backends
./upgrade.sh ../gachipad-<newer>.tar.gz           # checksums, load images, stop writers, backup, readiness, automatic rollback
```

`install.sh` checks `SHA256SUMS` inside the bundle; `upgrade.sh` accepts either `<bundle>.sha256` or the released `SHA256SUMS` next to the bundle, checks the archive before extracting, then verifies the internal `SHA256SUMS` before loading images. A checksum is not a signature: it only detects a changed or damaged bundle when the value itself arrives over a trusted channel.

api and collab connect as `gachipad_app` (readWrite on database `gachipad` only). The one-shot service `mongo-users` creates that user, or resets its password and role, as root on every start, so an installation from before this user existed switches over on its next upgrade without a manual step. Upgrading from such a version runs the old `upgrade.sh`: it finishes, then prints `tmp: unbound variable` and exits 1 because of a bug in its cleanup trap (fixed since), and leaves the extracted bundle in `/tmp/tmp.*`; check `docker compose ps` and remove that directory. `deploy/verify-deploy.sh` runs the whole path (fresh install, backup, restore, refused and accepted upgrades, HTTPS, an old installation) on a docker host.

## Updates

```sh
./update.sh --check                                  # installed vs newest release; changes nothing
./update.sh [--version X.Y.Z] [--yes] [--allow-major]  # online: checksums, staged pull/digests, stop writers, backup, readiness, rollback on failure
./update.sh --bundle ../gachipad-<v>-linux-amd64.tar.gz  # offline: same transaction and rollback as upgrade.sh
sudo ./update.sh --enable-auto --at 04:00 --policy patch   # daily automatic updates (systemd timer, or cron); --disable-auto
```

`update.sh` works in an installed bundle, not in this repository. Host health checks require curl; for a private CA, set `CURL_CA_BUNDLE` to a trusted CA bundle. It parses releases with Node in the installed API image (`docker compose run --no-deps --pull never`), so host Node, Python and jq are not needed. All updates, backups and restores share one install lock (`flock`, or atomic mkdir); offline upgrades use the same transaction. Images are downloaded/loaded and checked before Caddy and the writers stop; Collab must finish its SIGTERM flush before backup. Ingress stays closed until readiness passes. If ingress activation then fails, writers stop and the verified version and current DB are retained for manual recovery, preserving any writes already accepted. Rollback restores the DB before starting the previous app, and skips DB restore if the new app never started. Any Mongo image change requires a separate supported migration and is refused before backup. Automatic scheduling requires a path containing only letters, digits, `/ . _ -`.

It writes `state/update.json` (shown in the admin console: `./state` is mounted read-only into api) and `state/update.log`; no container gets the Docker socket. Settings: `UPDATE_REPO`, `UPDATE_CHANNEL` and `UPDATE_HEALTH_TIMEOUT` (180 s) from the environment or `.env`. The API's own release check is `UPDATE_CHECK` (on). Details, what is sent and the costs: `docs/OPERATIONS.md` §15. `deploy/update.test.sh` tests the script with fakes; `deploy/verify-update.sh` runs a real update and rollback on a docker host with a local registry.

Valkey holds join codes, presence, grants, network bans and quota counters; it is not part of the database backup. Keep its volume and do not flush it in production. See the operator security checklist in `docs/OPERATIONS.md`.

## Load test

`pnpm load -- --url http://gachipad.local --shares 100 --writers 5 --viewers 20 --duration 60` (see `scripts/load`). One machine is one client IP: raise `RATE_LIMIT_*` in `.env` for big runs.

## Notes

- `apps/api` and `apps/collab` have no build step; the images run the TypeScript sources with `tsx` (installed beside the app). `NODE_ENV=production` makes both refuse to start with weak secrets.
- Containers run as non-root where the image allows it (api, collab, Valkey, MongoDB drop privileges), with a read-only root filesystem for api and collab.
- Logs are capped at 3 x 10 MB per container.

Plain HTTP exposes document content and session/admin/PIN/edit/collab credentials to traffic observers. HTTPS setup and client CA trust instructions are in [tls/README.md](tls/README.md). Keep backups private and retain both the Mongo backup and protected Caddy CA volume.
