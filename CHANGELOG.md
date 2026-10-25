# Changelog

All notable changes to codesh are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The section of a version is the
text of its GitHub release (RELEASING.md).

## [Unreleased]

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

[Unreleased]: https://github.com/kim0040/codesh/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kim0040/codesh/releases/tag/v1.0.0
