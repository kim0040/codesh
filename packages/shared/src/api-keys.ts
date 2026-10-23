import { z } from "zod";

/**
 * Valkey keys and channels that only `apps/api` (and, for `apiChannels.doc`, `apps/collab`) use.
 * They extend the table of §7 and sit beside `keys.ts` so that file stays the contract's mirror.
 */

export const apiKeys = {
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
} as const;

export const apiChannels = {
  /** API -> collab: a server-side change to a live document (restore, title / language change). */
  doc: (shareId: string) => `doc:${shareId}` as const,
} as const;

/** Message on `doc:<shareId>`. `update` is a Yjs update, base64 encoded. */
export const docUpdateMessageSchema = z.object({ update: z.string() });
export type DocUpdateMessage = z.infer<typeof docUpdateMessageSchema>;
