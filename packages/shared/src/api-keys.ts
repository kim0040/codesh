/**
 * Valkey keys that only `apps/api` uses.
 * They extend the table of §7 and sit beside `keys.ts` so that file stays the contract's mirror.
 */

export const apiKeys = {
  pinFailsShare: (shareId: string) => `pinfail:s:${shareId}` as const,
  admittedNetworks: (shareId: string) => `admitted-net:${shareId}` as const,
  bannedNetworks: (shareId: string) => `banned-net:${shareId}` as const,
  quota: (kind: "shares" | "uploads" | "bytes", scope: "c" | "i", key: string) =>
    `quota:${kind}:${scope}:${key}` as const,
  streams: (scope: "c" | "i", key: string) => `sse:${scope}:${key}` as const,
  /** HASH clientId -> edit key presented at admission ("" when none). Who passed PIN / approval. */
  grants: (shareId: string) => `grants:${shareId}` as const,
  /** Monotonic counter behind `PermMessage.version`. */
  permVersion: (shareId: string) => `permv:${shareId}` as const,
  /** HASH {name, color}: display name and color, outlives `presence:user:*`. */
  profile: (clientId: string) => `profile:${clientId}` as const,
  /** HASH {provider, subject, name?, email?}: verified OIDC / LDAP identity bound to a session. */
  identity: (clientId: string) => `identity:${clientId}` as const,
  /** ZSET clientId -> lastSeen ms across every network group. */
  presenceAll: "presence:all",
  /** Cached first lines of a share for the "my shares" list. */
  preview: (shareId: string) => `preview:${shareId}` as const,
  /** ZSET `labId` -> expiresAt ms. */
  labsIndex: "labs:index",
  /** ZSET `uploadId:size` -> expiresAt ms. */
  uploadsIndex: "uploads:index",
  /** HASH {name, size, contentType, ownerId, expiresAt}: upload metadata, so checks need no file read. */
  uploadMeta: (uploadId: string) => `upload:meta:${uploadId}` as const,
  /** SET of clientIds and `net:<net>` entries allowed to download an upload they were sent. */
  uploadGrants: (uploadId: string) => `upload:grants:${uploadId}` as const,
  /** Pending OIDC login, value is JSON {clientId, nonce, codeVerifier}. */
  oidcState: (state: string) => `oidc:state:${state}` as const,
  /** STRING network group a share was announced in, so its `nearby:<net>` entry stays findable. */
  shareNet: (shareId: string) => `sharenet:${shareId}` as const,
  /** ZSET shareId -> expiresAt ms ("+inf" for saved shares); only feeds the admin stats. */
  sharesIndex: "shares:index",
  /** Wrong PIN attempts per share and client (5 per 10 min, §8). */
  pinFailsClient: (shareId: string, clientId: string) =>
    `pinfail:c:${shareId}:${clientId}` as const,
  /** Wrong PIN attempts per share and client IP, so dropping the cookie does not reset the limit. */
  pinFailsIp: (shareId: string, ip: string) => `pinfail:i:${shareId}:${ip}` as const,
  /** Serialises a student's join so a double click cannot create two forks. */
  labJoinLock: (labId: string, clientId: string) => `lock:labjoin:${labId}:${clientId}` as const,
  /** Lets one distribute per lab run at a time, so a double click cannot fork everyone twice. */
  labDistributeLock: (labId: string) => `lock:labdistribute:${labId}` as const,
  /** STRING JSON: what the update check last learned (one per deployment). */
  updateState: "update:state",
  /** Held by the one api instance that is asking GitHub right now. */
  updateLock: "lock:update-check",
  /** Cooldown of the admin console's "check now". */
  updateManual: "update:manual",
} as const;
