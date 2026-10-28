import { randomUUID } from "node:crypto";
import { apiKeys, keys } from "@gachipad/shared";
import { StorageCapacityError } from "@gachipad/storage";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { abuseKeys } from "./net.js";

export interface UploadMeta {
  id: string;
  pool?: { key: string; id: string };
  name: string;
  size: number;
  contentType: string | null;
  ownerId: string;
  /** Unix ms. */
  expiresAt: number;
}

/**
 * Streams a file into the FileStore (at most `maxBytes`; `FileTooLargeError` otherwise) and
 * mirrors its metadata into Valkey, so checks need no file read.
 */
export async function storeUpload(
  ctx: Ctx,
  input: {
    name: string;
    ip?: string;
    contentType: string | null;
    ownerId: string;
    stream: AsyncIterable<Uint8Array>;
    maxBytes: number;
  },
): Promise<UploadMeta> {
  const settings = await ctx.settings();
  const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
  const pool =
    ctx.config.network === "public"
      ? {
          key: keys.rateLimit(
            abuseKeys(input.ip ?? "unknown").at(-1)?.key ?? "unknown",
            "upload-pool",
          ),
          id: randomUUID(),
        }
      : undefined;
  const record = await ctx.stores.files
    .putStream(
      {
        name: input.name,
        contentType: input.contentType,
        ownerId: input.ownerId,
        expiresAt,
        stream: pool
          ? reserveUploadPool(ctx, pool, expiresAt.getTime(), input.stream)
          : input.stream,
      },
      input.maxBytes,
      ctx.config.limits.UPLOAD_STORAGE_MAX_BYTES,
    )
    .catch(async (error) => {
      if (pool) await releaseUploadPool(ctx, pool);
      if (error instanceof StorageCapacityError)
        throw new ApiError("unavailable", "Upload storage capacity reached; contact the operator");
      throw error;
    });
  const meta: UploadMeta = {
    id: record.id,
    ...(pool ? { pool } : {}),
    name: record.name,
    size: record.size,
    contentType: record.contentType,
    ownerId: record.ownerId,
    expiresAt: record.expiresAt.getTime(),
  };
  try {
    await cacheUploadMeta(ctx, meta);
  } catch (error) {
    await discardUpload(ctx, meta);
    throw error;
  }
  return meta;
}

/** Removes a stored upload again, for a request that failed after some of its files were stored. */
export async function discardUpload(ctx: Ctx, meta: UploadMeta): Promise<void> {
  await ctx.stores.files
    .delete(meta.id)
    .then(async () => {
      if (meta.pool) await releaseUploadPool(ctx, meta.pool);
    })
    .catch(() => undefined);
  await ctx.valkey
    .multi()
    .del(apiKeys.uploadMeta(meta.id))
    .zrem(apiKeys.uploadsIndex, `${meta.id}:${meta.size}`)
    .exec()
    .catch(() => undefined);
}

async function cacheUploadMeta(ctx: Ctx, meta: UploadMeta): Promise<void> {
  const key = apiKeys.uploadMeta(meta.id);
  await ctx.valkey
    .multi()
    .hset(key, {
      name: meta.name,
      size: String(meta.size),
      contentType: meta.contentType ?? "",
      ownerId: meta.ownerId,
      expiresAt: String(meta.expiresAt),
    })
    .pexpireat(key, meta.expiresAt)
    .zadd(apiKeys.uploadsIndex, meta.expiresAt, `${meta.id}:${meta.size}`)
    .exec();
}

export async function getUploadMeta(ctx: Ctx, id: string): Promise<UploadMeta | null> {
  const cached = await ctx.valkey.hgetall(apiKeys.uploadMeta(id));
  if (cached.ownerId && cached.name) {
    return {
      id,
      name: cached.name,
      size: Number(cached.size ?? 0),
      contentType: cached.contentType || null,
      ownerId: cached.ownerId,
      expiresAt: Number(cached.expiresAt ?? 0),
    };
  }
  // Valkey lost the entry (restart, flush); the FileStore is the source of truth.
  const stored = await ctx.stores.files.meta(id);
  if (!stored) return null;
  const meta: UploadMeta = {
    id,
    name: stored.name,
    size: stored.size,
    contentType: stored.contentType,
    ownerId: stored.ownerId,
    expiresAt: stored.expiresAt.getTime(),
  };
  await cacheUploadMeta(ctx, meta);
  return meta;
}

/** Owner, or anyone the owner sent it to (by client id or for the whole network group). */
export async function mayDownload(
  ctx: Ctx,
  meta: UploadMeta,
  session: { clientId: string; net: string },
): Promise<boolean> {
  if (meta.ownerId === session.clientId) return true;
  const grants = apiKeys.uploadGrants(meta.id);
  const [byClient, byNet] = await Promise.all([
    ctx.valkey.sismember(grants, session.clientId),
    ctx.valkey.sismember(grants, `net:${session.net}`),
  ]);
  return byClient === 1 || byNet === 1;
}

// Reserve each chunk atomically across replicas. Entries outlive quota windows and fresh cookies;
// the IPv6 /64 receives the same fraction as IPv4, without the usual rate-limit multiplier.
async function* reserveUploadPool(
  ctx: Ctx,
  pool: { key: string; id: string },
  expiresAt: number,
  source: AsyncIterable<Uint8Array>,
) {
  for await (const chunk of source) {
    const admitted = await ctx.valkey.eval(
      RESERVE_POOL,
      2,
      pool.key,
      `${pool.key}:sizes`,
      pool.id,
      expiresAt,
      chunk.byteLength,
      Math.floor(ctx.config.limits.UPLOAD_STORAGE_MAX_BYTES / 4),
    );
    if (Number(admitted) !== 1)
      throw new ApiError("unavailable", "Upload storage capacity for this address reached");
    yield chunk;
  }
}

async function releaseUploadPool(ctx: Ctx, pool: { key: string; id: string }): Promise<void> {
  await ctx.valkey.eval(
    `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`,
    2,
    pool.key,
    `${pool.key}:sizes`,
    pool.id,
  );
}

const RESERVE_POOL = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)
for _, id in ipairs(expired) do
  redis.call('HDEL', KEYS[2], id)
  redis.call('ZREM', KEYS[1], id)
end
local total = 0
for _, size in ipairs(redis.call('HVALS', KEYS[2])) do total = total + tonumber(size) end
if total + tonumber(ARGV[3]) > tonumber(ARGV[4]) then return 0 end
redis.call('HINCRBY', KEYS[2], ARGV[1], ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
local last = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], last[2])
redis.call('PEXPIREAT', KEYS[2], last[2])
return 1
`;
