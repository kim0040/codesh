/** Valkey key and channel builders (§7). Nothing else formats these strings. */

export const keys = {
  code: (code: string) => `code:${code}` as const,
  codeCooldown: (code: string) => `code:cool:${code}` as const,
  labCode: (code: string) => `labcode:${code}` as const,
  presenceNet: (net: string) => `presence:${net}` as const,
  presenceUser: (clientId: string) => `presence:user:${clientId}` as const,
  nearbyNet: (net: string) => `nearby:${net}` as const,
  nearbyItem: (id: string) => `nearby:item:${id}` as const,
  pending: (shareId: string) => `pending:${shareId}` as const,
  docLock: (id: string) => `doclock:${id}` as const,
  sweeperLock: "lock:sweeper",
  rateLimit: (ip: string, bucket: string) => `rl:${ip}:${bucket}` as const,
} as const;

export const channels = {
  perm: (shareId: string) => `perm:${shareId}` as const,
  cmd: (shareId: string) => `cmd:${shareId}` as const,
  cmdReply: (requestId: string) => `cmd-reply:${requestId}` as const,
  user: (clientId: string) => `user:${clientId}` as const,
  net: (net: string) => `net:${net}` as const,
} as const;
