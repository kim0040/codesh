# @codesh/api

Fastify 5 HTTP API (ARCHITECTURE §8–§10): sessions, sharing, join codes, waiting room, history, uploads, labs, admin, SSE, metrics.

## Run and test

```sh
pnpm services:up                       # Valkey (and MongoDB) for the dev stack
pnpm --filter @codesh/api test         # unit + route tests (CODESH_INTEGRATION=1, needs Valkey)
pnpm --filter @codesh/api test:unit    # unit tests only; route tests are skipped
```

Route tests use the real Valkey (database `1 + VITEST_POOL_ID`, flushed per harness) and the in-memory stores from `@codesh/storage`; `Harness.collab` stands in for collab on `cmd:*`. `collab.integration.test.ts` runs a real collab server on MongoDB and runs on its own after the route tests, because collab answers every `cmd:*` channel. `STORAGE=memory` starts the server with the memory stores too (development only; the default is `mongo`).

## Additions beyond §9

- **Auth (optional, off by default).** `GET /api/auth/providers`, `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback`, `POST /api/auth/ldap/login`, `POST /api/auth/logout`. A provider is on when its block in the admin settings is set. OIDC `state` lives in `oidc:state:<state>` for 10 minutes, is bound to the browser's `clientId` and consumed with `GETDEL`. A verified identity is stored in `identity:<clientId>` and shows in `GET /api/session` as `identity`. With `guestAllowed=false`, everything except the auth and health routes needs an identity.
- **Content changes go through collab.** The API never writes `share_updates` (§6.11). `PATCH /api/shares/:id` with `title` / `language` sends `{kind: 'meta'}` and `POST /api/shares/:id/restore` sends `{kind: 'restore', seq}` on `cmd:<shareId>`, then waits for `cmd-reply:<requestId>`. A refusal maps to `not_found` / `too_large`; no reply within `COLLAB_COMMAND_TIMEOUT_MS` (or `failed`) answers 503 `unavailable` and changes nothing. New shares are the exception: their initial content is stored as a seq-0 `compact` snapshot before any client connects.
- **Extra Valkey keys** (`apiKeys` in `packages/shared/src/api-keys.ts`): `sharenet:`, `shares:index`, `uploads:index`, `upload:meta:`, `pinfail:c:`, `pinfail:i:`, plus the keys listed in §8.
- `POST /api/shares` accepts bodies up to 32 MiB so `settings.maxDocBytes` decides what is too large, not Fastify's 1 MiB default.

## Behaviour worth knowing

- **Network group.** Rooms (CIDRs from settings) win; otherwise the client's /24 (IPv4) or /64 (IPv6). `X-Forwarded-For` is used only when the direct peer is in `TRUST_PROXY`, walking the header from the right and skipping trusted hops.
- **Join codes.** `SET NX EX` through a Lua script that also checks the other namespace (share vs lab) and the cooldown key. A code is blocked for `JOIN_CODE_COOLDOWN_SECONDS` after it was freed or expired.
- **PIN.** scrypt hash. 5 wrong tries in 10 minutes per client *and* per IP (dropping the cookie does not reset the limit) answer 429.
- **Protected shares are never nearby.** A PIN or approval requirement forces `access.nearby=false`.
- **Presence excludes the caller.** `GET /api/presence` lists the others in the network group.
- **Initial snapshot.** Every new share (and every lab fork and upload) is stored as a compact snapshot with seq 0, so collab loads it like any other document.
- **History restore** edits the stored document and appends the diff as a normal update; history stays server-side and only the owner can list or fetch it.
- **Languages** come from a local extension → id map (`src/languages.ts`).
- **Invites** accept `fileId` but do not use it yet.
- **Admin stats** are approximate: they come from the Valkey indexes (`shares:index`, `labs:index`, `uploads:index`, `presence:all`), not from MongoDB counts.
- **Uploads.** Downloads are always `application/octet-stream` attachments, whatever type the uploader claimed. `?asShare=1` accepts files, a folder (relative paths as file names) or a zip; binaries, `__MACOSX`, `.git`, `node_modules` and `.DS_Store` are skipped, unzipped size and file count are limited, and entries can't escape the root.
- **SSE.** One stream per browser, `: heartbeat` comments, closed when the client falls more than 1 MiB behind and on shutdown.
- `mongodb` is an `apps/api` dependency because the runtime loads `createMongoStores` lazily (not in tests).
