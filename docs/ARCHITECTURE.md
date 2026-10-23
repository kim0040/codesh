# codesh architecture contract

Developer-facing contract shared by every package. Product scope lives in `PLAN.md`; when this file and the code disagree, fix one of them in the same change.

## 1. Runtime topology

```
browser ──HTTP /api/*──────────▶ apps/api    (Fastify, :3001)
        ──SSE  /api/events─────▶ apps/api
        ──WS   /collab?doc=<id>▶ apps/collab (Hocuspocus, :3002)
apps/api, apps/collab ──▶ MongoDB 8 (:27017)   persistent state
apps/api, apps/collab ──▶ Valkey 8 (:6379)     pub/sub, presence, codes, caches
production: Caddy (:80/:443) serves apps/web/dist and proxies /api, /collab (lb_policy query doc)
dev: Vite (:5173) proxies /api → :3001 and /collab → :3002 (ws)
```

- One Valkey and one MongoDB. `apps/collab` can run N instances; `@hocuspocus/extension-redis` (ioredis, Valkey-compatible) keeps them in sync, and Caddy routes by `doc` query so one doc normally lives on one instance.
- No runtime request leaves the intranet. No CDN, font, analytics or external API.

## 2. Packages

| Path | Role |
|---|---|
| `packages/shared` | zod schemas + TS types for every API body/response, SSE event, awareness state, constants (limits, TTLs, key names) |
| `packages/storage` | `ShareStore`, `UpdateLog`, `FileStore`, `SettingsStore`, `AuditStore` interfaces + MongoDB implementation (official `mongodb` driver). Nothing else imports `mongodb` |
| `packages/highlight` | language registry (id, name, extensions, color, loader), CodeMirror themes (2 dark, 2 light) with WCAG-checked token colors, language detection |
| `packages/i18n` | `ko` and `en` dictionaries (same keys, typed), `t()` helper. Only these two locales |
| `packages/ui` | design tokens (CSS variables), Tailwind v4 theme, shared React components on Radix primitives |
| `packages/cli` | `codesh` CLI (`push`, `open`) |
| `apps/api` | REST + SSE, sessions, codes, permissions, presence, nearby, invites, uploads, labs, admin |
| `apps/collab` | Hocuspocus server, auth, permission enforcement, batched persistence, compaction, nearby previews |
| `apps/web` | React 19 SPA: intro page, editor, my shares, lab, admin |

## 3. Identifiers

| Thing | Format |
|---|---|
| share id | 8 chars base62, always contains at least one letter (`/^[0-9A-Za-z]{8}$/` and `/[A-Za-z]/`). URL `/<id>` |
| join code | 6 digits, no leading zero. URL `/<code>` resolves to `/<id>`. Allocated in Valkey with `SET code:<code> <id> NX EX <ttl>`; retry on collision; released codes are blocked for 24h (`code:cool:<code>`) |
| client id | UUID v4 created by the API on first visit, stored in signed httpOnly cookie `codesh_sid` (also returned to JS for awareness) |
| file id | `main` for the first file, else 8 chars base62 |
| lab id / lab code | same rules as share id / join code (`lab:` key prefix) |

## 4. Document model (one Y.Doc per share)

```
Y.Map  "meta"     { title: string, language: string (default file language) }
Y.Map  "files"    fileId -> Y.Map { path: string, language: string, order: number }
Y.Text "file:<fileId>"   file content
Y.Array "comments"  { id, fileId, anchor: RelativePosition(JSON), head: RelativePosition(JSON), author: {clientId,name,color}, body, createdAt, resolved }
```

- Server Y.Doc uses `gc: true`. The initial sync sends only the garbage-collected current state, so deleted text is never sent to a newly joining client.
- Awareness state (`packages/shared` `AwarenessState`): `{ user: {clientId, name, color}, fileId, cursor?: {anchor, head} (Yjs relative), viewport?: {fromLine, toLine}, following?: clientId }`. Clients throttle awareness to ≤30 updates/s; the collab server drops updates beyond that per connection, states over 4 KB, and states for Yjs clients another connection announced, and always sets `user` from the token.

## 5. MongoDB collections

| Collection | Shape | Indexes |
|---|---|---|
| `shares` | `{_id: id, title, language, ownerId, createdAt, updatedAt, lastActiveAt, expiresAt: Date|null, saved: bool, savedBy: clientId[], access: {default: 'edit'|'view', editKey, pinHash: string|null, requireApproval: bool, nearby: bool}, bans: clientId[], joinCode, labId?: string, forkOf?: id, locked: bool, sizeBytes}` | TTL on `expiresAt` (`expireAfterSeconds: 0`), `ownerId`, `savedBy`, `labId` |
| `share_updates` | `{shareId, seq: number, data: Binary, at: Date}` | unique `{shareId, seq}` |
| `share_snapshots` | `{shareId, seq, state: Binary, at: Date, kind: 'compact'|'history'}` | `{shareId, seq}` |
| `labs` | `{_id, title, ownerId, joinCode, templateShareId, locked, students: [{clientId, name, shareId, joinedAt}], createdAt, expiresAt}` | TTL on `expiresAt` |
| `fs.files` / `fs.chunks` | GridFS bucket `uploads`, metadata `{ownerId, shareId?, expiresAt}` | default + `metadata.expiresAt` |
| `settings` | single doc `_id: 'global'` (see §10) | |
| `audit` | `{at, actor: clientId, ip, action, shareId?, detail}` (only when audit enabled) | `{at: -1}`, TTL by retention |

- A sweeper (in `apps/collab`, every 10 min, guarded by a Valkey lock `lock:sweeper`) deletes updates/snapshots/uploads whose share no longer exists.
- Expiry: unsaved shares `expiresAt = lastActiveAt + settings.anonymousTtlHours` (default 24). Saving sets `expiresAt = null`.

## 6. Persistence and concurrency (apps/collab)

1. Live state is the in-memory Y.Doc held by Hocuspocus. Nothing on the keystroke path awaits MongoDB.
2. `onChange`/`onStoreDocument` are replaced by a custom extension: every Y update is appended to an in-memory per-doc buffer; a flusher writes buffers with `insertMany` every 100 ms (`seq` monotonically increasing per doc, owned by the instance that holds the doc lock `doclock:<id>` in Valkey).
3. Compaction: after 200 updates or when the doc unloads, write a `compact` snapshot (`Y.encodeStateAsUpdate`) and delete updates with `seq ≤ snapshot.seq`. History snapshots (`kind:'history'`) are kept every 30 s of activity for playback (owner only), up to `settings.historyRetentionDays` and at most the newest 100 per share.
4. Load: latest snapshot + updates after it.
5. Unload: 30 s after the last connection leaves, flush, compact, release lock.
6. Shutdown (SIGTERM): stop accepting, flush all buffers, compact, exit. Target data loss on crash ≤ 1 s.
7. Permissions: on connect the client sends a token (§8). The collab server verifies it, sets `connection.readOnly` for viewers and rejects updates from read-only connections. Permission changes arrive on Valkey channel `perm:<shareId>` with `{version, kind: 'role'|'kick'|'lock'|'delete', clientId?, role?}`; affected connections are closed or switched within 100 ms. `kick`, `lock` and `delete` apply whatever their `version`; only a per-client `role` older than one already applied is ignored. Pub/sub can lose messages, so collab also re-reads the share of every doc with connections every 15 s and after its subscriber reconnects (lock, bans, existence), and replays messages that arrived while a connection was authenticating. Database errors during authentication or load are refused with reason `unavailable` (retry with backoff), not as an access decision.
8. Slow clients: if a connection's buffered amount exceeds 4 MB, close it with code 4408; the client reconnects and resyncs.
9. Nearby previews: on change (throttled to 2 s), publish `{id, title, language, participants, preview: first 8 lines of main file}` into Valkey hash `nearby:item:<id>` (EX 60) when `access.nearby` is true.
10. `lastActiveAt` is written at most once per minute per doc.
11. Only apps/collab writes `share_updates`. Other services change document content through Valkey channel `cmd:<shareId>` with `{requestId, kind: 'restore', seq}` (restore history snapshot `seq`) or `{requestId, kind: 'replace', state: base64}` (apply a full Y state as a diff) or `{requestId, kind: 'meta', title?, language?, fileId?}`; collab opens the doc (direct connection if not loaded), applies the change as a normal update and replies on `cmd-reply:<requestId>` with `{ok, error?}` within 5 s. Initial content of a brand-new share (uploads, fork, CLI push) is written by the API as a `compact` snapshot at seq 0 before any client connects.
12. A client whose update was refused (read-only or `too_large`) must drop its local Y.Doc and resync (`packages/shared/src/collab.ts`).

## 7. Valkey keys and channels

| Key / channel | Use |
|---|---|
| `code:<code>` → id, `code:cool:<code>` | join codes |
| `labcode:<code>` → labId | lab join codes |
| `presence:<net>` ZSET clientId → lastSeen ms | online users per network group |
| `presence:user:<clientId>` HASH {name, color, net, room} EX 60 | user card |
| `nearby:<net>` ZSET id → lastActive ms, `nearby:item:<id>` HASH | nearby shares |
| `pending:<shareId>` HASH clientId → name | waiting room |
| `perm:<shareId>` channel | permission changes to collab |
| `user:<clientId>` channel | SSE events for one user |
| `net:<net>` channel | SSE events for a network group (broadcast) |
| `cmd:<shareId>` channel, `cmd-reply:<requestId>` channel | content commands to collab (§6.11): `restore`, `replace`, `meta` |
| `doclock:<id>`, `lock:sweeper` | instance ownership (SET NX PX + renew) |
| `rl:<ip>:<bucket>` | rate limiting |

Every pub/sub channel is prefixed with the optional env `CODESH_NS` (keys are isolated by Valkey database index instead, but pub/sub ignores it). Tests give each file its own namespace via `scripts/vitest-namespace.ts`; production leaves it empty or sets one per deployment sharing a Valkey.

Network group `net`: the room name when the client IP falls in a configured room CIDR (`settings.rooms: [{name, cidrs}]`), else the IPv4 /24 (`settings.subnetPrefixV4`, default 24) or IPv6 /64. Client IP is the socket address unless the socket address is in `TRUST_PROXY` CIDRs, then the right-most untrusted `X-Forwarded-For` entry (walking from the right; it cannot be spoofed).

## 8. Sessions and tokens

- `codesh_sid` cookie: signed (`@fastify/cookie`, `SESSION_SECRET`), httpOnly, SameSite=Lax, value = clientId. Display name/color are stored in `presence:user:*` and localStorage.
- Collab token: `base64url(JSON{shareId, clientId, name, color, role:'owner'|'edit'|'view', exp}) + '.' + HMAC-SHA256(COLLAB_SECRET)`, exp 10 min; the provider fetches a fresh token on reconnect via `POST /api/shares/:id/join`.
- PIN: bcrypt-free — `scrypt` (node:crypto) hash. 5 wrong attempts per client per 10 min → 429.
- Optional OIDC/LDAP login (settings) only maps a verified identity onto the clientId; anonymous use keeps working unless `settings.guestAllowed` is false.

## 9. HTTP API (apps/api)

All bodies and responses are zod schemas in `packages/shared`. Errors: `{error: {code, message}}` with HTTP status; codes are stable strings (`not_found`, `forbidden`, `pin_required`, `pin_invalid`, `banned`, `pending_approval`, `rate_limited`, `too_large`, `expired`, `validation`).

| Method & path | Purpose |
|---|---|
| `GET /api/session` | creates session if missing → `{clientId, name|null, color, net, room|null}` |
| `PATCH /api/session` | `{name?, color?}` |
| `POST /api/shares` | `{title?, language?, files?: [{path, language?, content}]}` → `{id, code, url}`; creator = owner |
| `GET /api/shares/:id` | meta + `{role, needsPin, requireApproval}` (no content) |
| `POST /api/shares/:id/join` | `{pin?, editKey?}` → `{token, role}` or 202 `{status:'pending'}` |
| `PATCH /api/shares/:id` | owner: title, language, access, saved, locked |
| `DELETE /api/shares/:id` | owner |
| `POST /api/shares/:id/save` / `DELETE …/save` | any participant: add/remove from "my shares" (`savedBy`), sets `expiresAt=null` while savedBy non-empty |
| `GET /api/shares` | my shares (owned ∪ saved), newest first, with language + preview |
| `GET /api/codes/:code` | → `{id}` or `{labId}` |
| `POST /api/shares/:id/kick` | owner `{clientId, ban}` |
| `GET /api/shares/:id/pending` / `POST …/pending/:clientId` | owner: list / `{approve}` |
| `POST /api/shares/:id/fork` | → new share id (copy of current state) |
| `GET /api/shares/:id/history` | owner: `[{seq, at}]`; `GET …/history/:seq` → binary state |
| `POST /api/shares/:id/restore` | owner `{seq}` → applies a diff that turns the doc into that state (normal update, keeps history) |
| `GET /api/shares/:id/download` | `?file=<fileId>` single file, else zip of all files |
| `GET /api/nearby` | nearby shares in my `net` |
| `GET /api/presence` | online users in my `net` |
| `POST /api/invites` | `{to: clientId | 'net', shareId, fileId?, uploadId?, note?}` |
| `POST /api/uploads` | multipart (files or zip/folder), limit `settings.maxUploadMB` → `[{uploadId, name, size}]`; `?asShare=1` creates a multi-file share |
| `GET /api/uploads/:uploadId` | download |
| `POST /api/labs`, `GET /api/labs/:id`, `POST /api/labs/:id/join`, `PATCH /api/labs/:id` (`locked`, `templateShareId`), `POST /api/labs/:id/distribute` | lab mode |
| `GET /api/events` | SSE (§9.1) |
| `GET/PUT /api/admin/settings`, `GET /api/admin/audit`, `GET /api/admin/stats` | `Authorization: Bearer <ADMIN_TOKEN>` |
| `GET /healthz`, `GET /metrics` | health + Prometheus (prom-client) |

### 9.1 SSE events (`GET /api/events`)

`event: <type>` + JSON `data`. Heartbeat comment every 15 s. Types: `presence` (full list for my net), `nearby` (full list), `invite` `{from, shareId, title, language, note?, uploadId?}`, `broadcast` `{from, shareId, title}`, `approval-request` `{shareId, clientId, name}`, `approval-result` `{shareId, approved}`, `kicked` `{shareId, banned}`, `lab` `{labId, kind}`.
While a client has an open SSE stream the API refreshes its presence every 20 s.

## 10. Settings (`settings` doc, admin-editable, env provides defaults)

`anonymousTtlHours` 24, `historyRetentionDays` 7, `maxDocBytes` 5 MB (at most 12 MiB, below MongoDB's 16 MiB document limit), `maxUploadMB` 200, `guestAllowed` true, `rooms` [], `subnetPrefixV4` 24, `nearbyDefault` true, `audit.enabled` false, `audit.retentionDays` 90, `secretWarning` true, `auth.oidc` null, `auth.ldap` null, `contact` "".

## 11. Web app

- Routes: `/` intro + start, `/:code(\d{6})` resolve, `/:id` editor, `/me` my shares, `/lab/:id` lab (teacher grid / student), `/admin`.
- State: TanStack Query for REST, one `EventSource` for SSE, one `HocuspocusProviderWebsocket` per tab (multiplexes docs; lab grid uses it).
- Editor: CodeMirror 6 + `y-codemirror.next` (`yCollab`), keymaps via `@replit/codemirror-vim`, `@replit/codemirror-emacs`, sublime-style bindings from `@codemirror/commands`.
- Smoothness: local edits render immediately; remote cursors animate position with CSS transforms; route transitions via the View Transitions API with a reduced-motion fallback; skeletons instead of spinners; optimistic UI for title/language/settings.
- Offline: `y-indexeddb` copy per doc; banner shows "offline – changes kept" and merges on reconnect.
- PWA: `vite-plugin-pwa`; notifications use the Notification API while the app is open (no external push service exists on an intranet).

## 12. Commands

| Command | Where |
|---|---|
| `scripts/box <cmd>` | sync the working tree to the instabox dev box and run `<cmd>` there. **All installs, builds, tests, dev servers and docker run through this.** |
| `pnpm dev` | turbo: web + api + collab (needs `pnpm services:up`) |
| `pnpm services:up` / `services:down` | docker compose: MongoDB 8 + Valkey 8 |
| `pnpm check` | biome lint/format check + `tsc -b` + vitest + license check |
| `pnpm test:e2e` | Playwright (Chromium) against a running dev stack |
| `pnpm load` | Node WebSocket load script (`scripts/load`) |

## 13. Dependency policy

Allowed licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, OFL-1.1 (fonts), Python-2.0 (tooling only), CC-BY-4.0 (data only). MPL-2.0 is allowed for dev-only build tools used unmodified (lightningcss via Tailwind/Vite) and must never appear in the production dependency set. `pnpm check` fails on anything else. Valkey (BSD) instead of Redis ≥7.4. MongoDB Community Server (SSPL) is used only as the internal database of this app and is not redistributed in the repo; drivers are Apache-2.0. No k6 (AGPL): load tests are a Node script.
