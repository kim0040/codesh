# Changelog

All notable changes to gachipad are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The section of a version is the
text of its GitHub release (RELEASING.md).

## [1.1.0] - 2026-10-28

### Added

- Selectable database backends: SQLite with WAL mode as the default for new installations, bundled PostgreSQL 17, bundled MongoDB 8, and external PostgreSQL, MySQL, MariaDB, or MongoDB reached via `DATABASE_URL` (MySQL and MariaDB are supported as external servers only; Valkey remains mandatory for all backends).
- Database selection during installation: `install.sh --db sqlite|postgres|mongodb|external` (with `--database-url` or interactive prompt for external databases, and local database and client detection on TTY).
- Backend-specific backups and restores: online consistent SQLite snapshots via `VACUUM INTO` without live WAL locks, transactional PostgreSQL backups and staged restores via `pg_dump` and `pg_restore`, MongoDB archives via `mongodump` and `mongorestore`, and safety-backup guarantees before destructive restores. External databases require operator-managed server backups and explicit acknowledgment (`GACHIPAD_EXTERNAL_BACKUP_CONFIRMED=1`).
- Offline database migration tool: `migrate-db.sh` for safe offline transitions between backends (`--to sqlite|postgres|mongodb|external`), featuring preflight validation, quiescent source backup, transactional state recovery, and automatic rollback on failure while preserving original backend volumes and data.
- Offline copy CLI and tunable copy window: `copy-db` CLI tool supporting cross-backend data transfer with SHA-256 integrity verification, skipping diagnostics and near-expiry records, and `migrate-db.sh --window-minutes` (or `GACHIPAD_COPY_WINDOW_MINUTES`, 15 to 1440 minutes, default 15) to scale the deadline and expiration margin for larger databases.
- Code completion: optional keyword and word suggestions in the editor that appear after a short pause in typing (or Ctrl+Space) and are accepted with Tab or Enter, drawn from language keywords and words in the document; disabled for viewers or when turned off in Settings.
- Language suggestion: automatic programming language detection while typing plain text, displaying a suggestion badge in the status bar with one-click acceptance or dismissal.
- First-run tutorial and replay: a lazy-loaded step-by-step tour with a spotlight overlay guiding new users through key controls on their first editor visit, replayable anytime from Settings.
- Guide pages: dedicated in-app documentation under `/guide` covering workflow, features, network topology, privacy/security, and FAQs, with lazy per-language copy and redirection from legacy home-page section anchors.
- Local diagnostics export: bounded client-side diagnostics in Settings (up to 500 event groups, 256 KB, 14-day retention) and server-side diagnostics in the admin console, with manual JSON export and zero automated external telemetry.
- Richer admin console: new dedicated panels for Overview (real-time metrics, system health badges, 24-hour activity chart), Shares (title search, pagination, Lock/Unlock and permanent Delete actions), Diagnostics (level, source, and timeframe filters, plus server bundle export), and Security (rate limits, proxy status, and sampled failed-login audit).
- Owner-controlled participant permissions: three new access switches in Share → Access (`allowParticipantRename`, `allowParticipantFiles`, `allowParticipantLanguage`), defaulting to off and enforced on both the API and collab server.
- Release source maps: web source maps packaged as `gachipad-web-sourcemaps-<version>.tar.gz` attached to GitHub releases alongside `scripts/symbolicate.mjs` for post-hoc symbolication, excluded from runtime container images.

### Changed

- Renamed product from codesh to gachipad (Korean reading 같이패드).
- Repository URL updated to `https://github.com/kim0040/gachipad`.
- Monorepo package scope renamed from `@codesh/*` to `@gachipad/*`.
- Primary CLI binary renamed to `gachipad` (`codesh` retained as a deprecated alias). CLI configuration resolves from `gachipad.json` (and `GACHIPAD_CONFIG` / `GACHIPAD_URL`) with fallback to `codesh.json` (and `CODESH_CONFIG` / `CODESH_URL`).
- Container images renamed on GitHub Container Registry to `ghcr.io/kim0040/gachipad-web`, `gachipad-api`, `gachipad-collab`, and `gachipad-mdns`.
- Release asset archives renamed to `gachipad-deploy-<version>.tar.gz`, `gachipad-<version>-linux-<arch>.tar.gz`, and `gachipad-web-sourcemaps-<version>.tar.gz` (legacy-named aliases continue to be published for 1.0.x updaters).
- Deployment environment variables migrated from `CODESH_*` to `GACHIPAD_*` (`GACHIPAD_VERSION`, `GACHIPAD_REGISTRY`, `GACHIPAD_PROJECT`, `GACHIPAD_NS`, `GACHIPAD_DATA_DIR`). Upgraded `.env` files comment out old `CODESH_*` lines; real exported `CODESH_*` variables fall back with a deprecation warning.
- Default mDNS host changed to `gachipad.local` (`codesh.local` retained as an alias for upgraded installations).
- Systemd unit and cron scheduler renamed to `gachipad-update` (existing `codesh-update` installations retain their unit name and timer until 2.0).
- CSRF protection header updated to `X-Gachipad: 1` (exact legacy `X-Codesh: 1` header accepted until 2.0).
- Session cookie renamed to `gachipad_sid` (signed `codesh_sid` fallback accepted and cleared on rotation until 2.0).
- In-browser IndexedDB and communication channels use `gachipad:*` names on fresh profiles; upgraded browser profiles safely retain `codesh:*` databases and `codesh:device` BroadcastChannel to prevent data fragmentation with legacy tabs.
- Renamed Prometheus metrics:
  - API: `codesh_http_request_duration_seconds` -> `gachipad_http_request_duration_seconds`, `codesh_shares_created_total` -> `gachipad_shares_created_total`, `codesh_rate_limited_total` -> `gachipad_rate_limited_total`, `codesh_sse_connections` -> `gachipad_sse_connections`, default collection prefix `codesh_api_*` -> `gachipad_api_*`.
  - Collab: `codesh_collab_connections` -> `gachipad_collab_connections`, `codesh_collab_documents_loaded` -> `gachipad_collab_documents_loaded`, `codesh_collab_flush_seconds` -> `gachipad_collab_flush_seconds`, `codesh_collab_flush_errors_total` -> `gachipad_collab_flush_errors_total`, `codesh_collab_updates_total` -> `gachipad_collab_updates_total`, `codesh_collab_slow_client_closes_total` -> `gachipad_collab_slow_client_closes_total`, `codesh_collab_refused_too_large_total` -> `gachipad_collab_refused_too_large_total`, `codesh_collab_ws_messages_sent_total` -> `gachipad_collab_ws_messages_sent_total`, `codesh_collab_ws_bytes_sent_total` -> `gachipad_collab_ws_bytes_sent_total`, `codesh_collab_awareness_dropped_total` -> `gachipad_collab_awareness_dropped_total`, default collection prefix `codesh_collab_*` -> `gachipad_collab_*`.
- Upgrades via `./update.sh` or `./upgrade.sh` preserve existing data, Docker volumes, MongoDB database name (`codesh`), user (`codesh_app`), and secrets without manual data migration.
- Registry mirrors must carry `gachipad-*` images at the release version.
- Exported-only `CODESH_REGISTRY` must be added to `.env` as `GACHIPAD_REGISTRY`.
- Source checkouts must run `./generate-secrets.sh .env` once after `git pull` before rebuilding containers.
- Operator-provided TLS certificates require `gachipad.local` in Subject Alternative Names (SAN) before setting `SITE_ALIASES=, gachipad.local`.
- `install.sh` refuses fresh installation when legacy `codesh_mongo-data` volume is detected without `.env` unless `GACHIPAD_NEW_INSTALL=1` is specified.
- Smooth caret and blinking: cursor glides with a 100 ms decelerating curve during local typing and navigation, with a 1.2 s ease-in-out blink cycle; caret stays solid when reduced motion is preferred.
- App-wide motion polish: smooth scale and translate transitions on button presses, switches, tab switching, and dialogs, with motion-safe fallbacks for users preferring reduced motion.
- Admin access hardening: optional `ADMIN_ALLOW_CIDR` restricts admin console and API access to trusted IPv4 and IPv6 networks before token verification, sessions, or database operations.
- Global admin guess budget: shared Valkey token bucket (capacity 100, refilling 100 per 10 minutes) across API replicas pausing wrong token guesses for 30 seconds upon depletion, while allowing correct tokens and CIDR-allowlisted addresses to bypass lockout.
- Admin HTTP warning: persistent banner alerting operators when accessing the admin console over unencrypted plain HTTP on non-loopback hosts.

### Fixed

- Live cursor stability: remote document edits no longer restart the local caret blink rhythm, and remote cursors and participant name tags retain their DOM identity through participant list changes without flashing.
- Projector mode fullscreen: stabilized fullscreen callback handling so remote edits, participant joins/departures, and React StrictMode re-renders do not exit projector fullscreen mode.
- iOS focus zoom: prevented automatic viewport zooming when focusing form controls across all iOS browsers (WebKit-based), while preserving pinch zoom.
- Tab bar scrollbar: eliminated an unnecessary vertical scrollbar on horizontal file tab lists across browsers.
- Preserved unsent text: when an edit is refused by server permissions or a lock change, unsent local changes are preserved in a tab-memory recovery dialog with a one-click copy option.

### Security

- Server-side participant permissions: collab update guard verifies all operation roots against document state and rejects unauthorized file additions, renames, deletions, and language changes before broadcast or persistence.
- Diagnostics privacy scrubbing: strict field scrubber replaces property keys and exception messages with safe categories/templates, excludes document contents, file names, PINs, and auth tokens, and enforces byte and group limits.
- Collab update rate limiting: per-connection token bucket (burst 200 updates, sustained refill of 50 updates/second) protecting collab instances against update flooding.
- Admin token enforcement: production startup rejects nonempty admin tokens shorter than 32 characters, and documented token rotation via `openssl rand -hex 32` and an API restart.

## [1.0.1] - 2026-10-25

### Fixed

- When someone opened a share read-only and then pasted an edit link (`#key=...`) into that same
  open tab, the editor could stay read-only with the read-only banner showing, mostly in Safari;
  reloading fixed it. Now the editor switches to editing as soon as the key is accepted.
- With smooth typing on, the cursor sometimes jumped to its new place instead of gliding
  while typing, when something unrelated on the page updated at the same moment. It now glides
  for every keystroke.

## [1.0.0] - 2026-10-25

The first release: real-time code sharing for one network, with no outside service at runtime.

### Added

- Shares with real-time editing (Yjs and Hocuspocus): several files per share, cursors and
  selections of everyone, offline edits merged on reconnect, syntax highlighting for 200+
  languages with contrast-checked themes, Vim, Emacs and Sublime keymaps.
- Joining by 6-digit code, link or QR code; nearby shares by network or admin-defined rooms;
  sending a share to someone online and broadcasting it to a room.
- Access control: view-only links, PIN lock, waiting room with approval, kick and ban, edit lock.
  Participants only ever receive the current text; edit history stays with the owner.
- History playback and restore, comments, downloads as files or .zip, uploads of files, folders
  and archives.
- Lab mode for teaching: a live grid of every student's copy and one-click distribution.
- `codesh` CLI: `push`, `open`, `pull`.
- Admin console: settings, rooms, templates, sign-in through OIDC or LDAP, audit log, status.
- Updates: the admin console shows when a newer release exists (one plain GET to the GitHub
  API, off with `UPDATE_CHECK=off`); only stable, non-draft releases are offered unless the
  pre-release channel is chosen. After a server update, open tabs offer a reload; a reload
  applies only to the tab where the person clicked, after its pending edits are confirmed.
  `update.sh` updates a server (optionally every day within a chosen window): it verifies
  checksums and prepares images before maintenance, waits for the collab server to save its data
  before the backup, and restores the database before starting the previous version if the new one
  fails. Online and offline updates share file recovery and one installation lock with
  backup/restore. A MongoDB image change is refused (it needs a separate migration). Offline
  upgrades accept the release's SHA256SUMS next to the bundle.
- Deployment: Docker Compose with Caddy, MongoDB 8 and Valkey 8; images on GHCR for
  linux/amd64 and linux/arm64 with build provenance; offline bundles with checksums for hosts
  without internet; backup, restore and upgrade scripts.
- Korean and English UI, keyboard operation throughout, WCAG 2.2 AA contrast, layouts down to
  320 px.

### Security

- Edit links carry the key in the URL fragment (`#key=`), which browsers do not send to servers;
  it is moved into memory and removed from the address bar; `?key=` links still work and are
  cleaned the same way.
- Offline copies: the browser keeps no offline copy until the person answers a one-time question
  in the editor (keep / not on this device; changeable in Settings). "Forget on this device" closes
  the share in every tab, deletes its copy and saved edit key. Removal, a ban, a refused
  authorization, a deleted share, signing out and switching accounts delete copies and remembered
  edit keys in every open tab. Shares with a PIN or approval load their copy only after the server
  accepts the connection. Lab previews never keep copies.

[1.1.0]: https://github.com/kim0040/gachipad/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/kim0040/codesh/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/kim0040/codesh/releases/tag/v1.0.0
