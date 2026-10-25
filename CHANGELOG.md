# Changelog

All notable changes to codesh are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The section of a version is the
text of its GitHub release (RELEASING.md).

## [Unreleased]

## [1.0.2] - 2026-10-25

### Added

- Code completion: optional keyword and word suggestions in the editor that appear after a short pause in typing (or Ctrl+Space) and are accepted with Tab or Enter, drawn from language keywords and words in the document; disabled for viewers or when turned off in Settings.
- Language suggestion: automatic programming language detection while typing plain text, displaying a suggestion badge in the status bar with one-click acceptance or dismissal.
- First-run tutorial and replay: a lazy-loaded step-by-step tour with a spotlight overlay guiding new users through key controls on their first editor visit, replayable anytime from Settings.
- Guide pages: dedicated in-app documentation under `/guide` covering workflow, features, network topology, privacy/security, and FAQs, with lazy per-language copy and redirection from legacy home-page section anchors.
- Local diagnostics export: bounded client-side diagnostics in Settings (up to 500 event groups, 256 KB, 14-day retention) and server-side diagnostics in the admin console, with manual JSON export and zero automated external telemetry.
- Richer admin console: new dedicated panels for Overview (real-time metrics, system health badges, 24-hour activity chart), Shares (title search, pagination, Lock/Unlock and permanent Delete actions), Diagnostics (level, source, and timeframe filters, plus server bundle export), and Security (rate limits, proxy status, and sampled failed-login audit).
- Owner-controlled participant permissions: three new access switches in Share → Access (`allowParticipantRename`, `allowParticipantFiles`, `allowParticipantLanguage`), defaulting to off and enforced on both the API and collab server.
- Release source maps: web source maps packaged as `codesh-web-sourcemaps-<version>.tar.gz` attached to GitHub releases alongside `scripts/symbolicate.mjs` for post-hoc symbolication, excluded from runtime container images.

### Changed

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

[Unreleased]: https://github.com/kim0040/codesh/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/kim0040/codesh/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/kim0040/codesh/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/kim0040/codesh/releases/tag/v1.0.0
