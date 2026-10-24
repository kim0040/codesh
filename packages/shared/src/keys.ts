/** Valkey key and channel builders (§7). Nothing else formats these strings. */

/**
 * Optional namespace (env `CODESH_NS`) prepended to every pub/sub channel. Keys are isolated by the
 * Valkey database index, but pub/sub ignores it, so deployments or parallel test runs sharing one
 * Valkey need this to keep their messages apart. Read on every call; empty by default.
 */
export function namespace(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.CODESH_NS ?? "";
}

export const keys = {
  code: (code: string) => `code:${code}` as const,
  codeCooldown: (code: string) => `code:cool:${code}` as const,
  labCode: (code: string) => `labcode:${code}` as const,
  presenceNet: (net: string) => `presence:${net}` as const,
  presenceUser: (clientId: string) => `presence:user:${clientId}` as const,
  nearbyNet: (net: string) => `nearby:${net}` as const,
  nearbyItem: (id: string) => `nearby:item:${id}` as const,
  pending: (shareId: string) => `pending:${shareId}` as const,
  commandReceipt: (shareId: string, requestId: string) =>
    `cmd:receipt:${shareId}:${requestId}` as const,
  docLock: (id: string) => `doclock:${id}` as const,
  sweeperLock: "lock:sweeper",
  rateLimit: (ip: string, bucket: string) => `rl:${ip}:${bucket}` as const,
} as const;

export const channels = {
  /** psubscribe patterns for the collab server. */
  permPattern: () => `${namespace()}perm:*`,
  cmdPattern: () => `${namespace()}cmd:*`,
  perm: (shareId: string) => `${namespace()}perm:${shareId}` as const,
  cmd: (shareId: string) => `${namespace()}cmd:${shareId}` as const,
  cmdReply: (requestId: string) => `${namespace()}cmd-reply:${requestId}` as const,
  user: (clientId: string) => `${namespace()}user:${clientId}` as const,
  net: (net: string) => `${namespace()}net:${net}` as const,
} as const;
