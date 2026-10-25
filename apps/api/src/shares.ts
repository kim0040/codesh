import {
  type Access,
  apiKeys,
  type CreateShareResponse,
  generateShareId,
  keys,
  type ShareRecord,
} from "@gachipad/shared";
import { codeTtlSeconds } from "./access.js";
import { allocateCode, releaseCode, touchCode } from "./codes.js";
import { randomKey } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { buildDoc, contentBytes, previewOf, readContent, storeInitialState } from "./docs.js";
import { tooLarge } from "./errors.js";
import { DEFAULT_LANGUAGE, languageForPath } from "./languages.js";
import { announceShare, removeNearby } from "./presence.js";
import { chargeQuota } from "./quotas.js";

export interface CreateShareInput {
  ownerId: string;
  ip?: string;
  title: string;
  language?: string;
  files: { path: string; language?: string; content: string }[];
  /** Network group to announce the share in; omit for shares that never appear nearby. */
  net?: string;
  labId?: string;
  forkOf?: string;
  access?: Partial<Pick<Access, "default" | "nearby" | "requireApproval">>;
  locked?: boolean;
}

export const urlOf = (ctx: Ctx, path: string) => `${ctx.config.publicUrl}/${path}`;

/** Creates the record, the join code and the first snapshot of the document. */
export async function createShare(
  ctx: Ctx,
  input: CreateShareInput,
): Promise<{ share: ShareRecord; response: CreateShareResponse }> {
  const settings = await ctx.settings();
  const files = input.files.map((file) => ({
    path: file.path,
    content: file.content,
    language: file.language ?? languageForPath(file.path),
  }));
  const language = input.language ?? files[0]?.language ?? DEFAULT_LANGUAGE;
  const doc = buildDoc({ title: input.title, language, files });
  const content = readContent(doc);
  const sizeBytes = contentBytes(content);
  if (sizeBytes > settings.maxDocBytes) {
    throw tooLarge(`A share holds at most ${settings.maxDocBytes} bytes of text`);
  }

  await chargeQuota(ctx, input.ownerId, input.ip, "shares");
  await chargeQuota(ctx, input.ownerId, input.ip, "bytes", sizeBytes);
  let id = generateShareId();
  while (await ctx.stores.shares.get(id)) id = generateShareId();
  const ttlSeconds = Math.round(settings.anonymousTtlHours * 3600);
  const code = await allocateCode(ctx, "share", id, ttlSeconds);

  const now = new Date();
  const preview = previewOf(content);
  const share: ShareRecord = {
    id,
    title: input.title,
    language,
    ownerId: input.ownerId,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    saved: false,
    savedBy: [],
    access: {
      default: input.access?.default ?? "edit",
      editKey: randomKey(),
      pinHash: null,
      requireApproval: input.access?.requireApproval ?? false,
      nearby: input.access?.nearby ?? settings.nearbyDefault,
      allowParticipantRename: false,
      allowParticipantFiles: false,
      allowParticipantLanguage: false,
    },
    bans: [],
    joinCode: code,
    ...(input.labId ? { labId: input.labId } : {}),
    ...(input.forkOf ? { forkOf: input.forkOf } : {}),
    locked: input.locked ?? false,
    sizeBytes,
    preview,
    previewAt: now,
  };
  try {
    await ctx.stores.shares.create(share);
    await storeInitialState(ctx, id, doc);
  } catch (error) {
    await ctx.stores.shares.delete(id).catch(() => undefined);
    await ctx.stores.snapshots.deleteForShare(id).catch(() => undefined);
    await releaseCode(ctx, "share", code).catch(() => undefined);
    throw error;
  }

  await ctx.valkey.zadd(apiKeys.sharesIndex, share.expiresAt?.getTime() ?? now.getTime(), id);
  if (input.net) await announceShare(ctx, share, input.net, preview);
  ctx.metrics.sharesCreated.inc();
  return { share, response: { id, code, url: urlOf(ctx, id) } };
}

/**
 * Everything that belongs to a share, in the order that leaves no orphan visible to users.
 * The record goes first, so a collab instance that re-reads it after the message finds it gone;
 * an update flushed after the delete is removed by the sweeper.
 */
export async function deleteShare(ctx: Ctx, share: ShareRecord): Promise<void> {
  await ctx.stores.shares.delete(share.id);
  await ctx.publishPerm(share.id, "delete");
  await Promise.all([
    ctx.stores.updates.deleteForShare(share.id),
    ctx.stores.snapshots.deleteForShare(share.id),
    ctx.stores.files.deleteForShare(share.id),
    ctx.stores.labels.deleteForShare(share.id),
    releaseCode(ctx, "share", share.joinCode),
    removeNearby(ctx, share.id),
    ctx.valkey.zrem(apiKeys.sharesIndex, share.id),
    ctx.valkey.del(
      apiKeys.grants(share.id),
      keys.pending(share.id),
      apiKeys.preview(share.id),
      apiKeys.admittedNetworks(share.id),
      apiKeys.bannedNetworks(share.id),
    ),
  ]);
}

/** Re-applies the code and index TTLs after `expiresAt` changed (save, unsave). */
export async function syncExpiry(ctx: Ctx, share: ShareRecord): Promise<void> {
  await touchCode(ctx, "share", share.joinCode, codeTtlSeconds(share));
  await ctx.valkey.zadd(
    apiKeys.sharesIndex,
    share.expiresAt ? share.expiresAt.getTime() : "+inf",
    share.id,
  );
}
