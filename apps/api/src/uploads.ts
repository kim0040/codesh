import { apiKeys } from "@codesh/shared";
import type { Ctx } from "./ctx.js";

export interface UploadMeta {
  id: string;
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
    contentType: string | null;
    ownerId: string;
    stream: AsyncIterable<Uint8Array>;
    maxBytes: number;
  },
): Promise<UploadMeta> {
  const settings = await ctx.settings();
  const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
  const record = await ctx.stores.files.putStream(
    {
      name: input.name,
      contentType: input.contentType,
      ownerId: input.ownerId,
      expiresAt,
      stream: input.stream,
    },
    input.maxBytes,
  );
  const meta: UploadMeta = {
    id: record.id,
    name: record.name,
    size: record.size,
    contentType: record.contentType,
    ownerId: record.ownerId,
    expiresAt: record.expiresAt.getTime(),
  };
  await cacheUploadMeta(ctx, meta);
  return meta;
}

/** Removes a stored upload again, for a request that failed after some of its files were stored. */
export async function discardUpload(ctx: Ctx, meta: UploadMeta): Promise<void> {
  await ctx.stores.files.delete(meta.id).catch(() => undefined);
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
