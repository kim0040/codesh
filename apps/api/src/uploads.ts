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

/** Stores a file in the FileStore and mirrors its metadata into Valkey, so checks need no file read. */
export async function storeUpload(
  ctx: Ctx,
  input: { name: string; contentType: string | null; ownerId: string; data: Uint8Array },
): Promise<UploadMeta> {
  const settings = await ctx.settings();
  const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
  const record = await ctx.stores.files.put({
    name: input.name,
    contentType: input.contentType,
    ownerId: input.ownerId,
    expiresAt,
    data: input.data,
  });
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
  const stored = await ctx.stores.files.get(id);
  if (!stored) return null;
  const meta: UploadMeta = {
    id,
    name: stored.meta.name,
    size: stored.meta.size,
    contentType: stored.meta.contentType,
    ownerId: stored.meta.ownerId,
    expiresAt: stored.meta.expiresAt.getTime(),
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
