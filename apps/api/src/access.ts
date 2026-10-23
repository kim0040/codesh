import {
  apiKeys,
  COLLAB_TOKEN_TTL_SECONDS,
  type GetShareResponse,
  keys,
  PIN_ATTEMPT_WINDOW_SECONDS,
  PIN_MAX_ATTEMPTS,
  type Role,
  type ShareMeta,
  type ShareRecord,
  signCollabToken,
} from "@codesh/shared";
import { touchCode } from "./codes.js";
import { safeEqual, verifyPin } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { ApiError, notFound } from "./errors.js";
import { refreshNearby } from "./presence.js";
import { displayName, type Session } from "./session.js";

/** Who may do what with a share: roles (§8), PIN, approval, bans, lock. */

/** Wrong PINs per share and client IP in one window; generous because a classroom can share an IP. */
const PIN_IP_MAX_ATTEMPTS = 30;
const GRANT_TTL_SECONDS = 30 * 24 * 3600;
const PENDING_TTL_SECONDS = 24 * 3600;

export async function findShare(ctx: Ctx, id: string): Promise<ShareRecord> {
  const share = await ctx.stores.shares.get(id);
  if (!share) throw notFound("Share not found");
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
    throw new ApiError("expired", "This share has expired");
  }
  return share;
}

export interface Access {
  owner: boolean;
  /** The teacher of the lab this share belongs to: edits any student share, even when locked. */
  teacher: boolean;
  /** Passed PIN and approval (or does not need to). */
  granted: boolean;
  needsPin: boolean;
  needsApproval: boolean;
  /** Null until PIN and approval are done. */
  role: Role | null;
  /** Waiting for the owner's decision. */
  pending: boolean;
}

/**
 * Computes the viewer's standing without changing anything.
 * `presentedKey` is an edit key from the request; an earlier presented one is remembered in the
 * share's grants, so rotating the key also revokes edit rights handed out with the old one.
 */
export async function accessOf(
  ctx: Ctx,
  share: ShareRecord,
  session: Session,
  presentedKey?: string,
): Promise<Access> {
  const { clientId } = session;
  if (share.bans.includes(clientId))
    throw new ApiError("banned", "You were removed from this share");
  const owner = share.ownerId === clientId;
  const lab = share.labId ? await ctx.stores.labs.get(share.labId) : null;
  const teacher = lab !== null && lab.ownerId === clientId;
  const [grantKey, pending] = await Promise.all([
    ctx.valkey.hget(apiKeys.grants(share.id), clientId),
    ctx.valkey.hexists(keys.pending(share.id), clientId),
  ]);
  const granted = owner || teacher || grantKey !== null;
  const keyOk = [presentedKey, grantKey].some(
    (candidate) => !!candidate && safeEqual(candidate, share.access.editKey),
  );
  let role: Role = owner ? "owner" : teacher ? "edit" : keyOk ? "edit" : share.access.default;
  // A locked share is read-only for everyone but the controller: the teacher in a lab, else the
  // owner. In a lab the student owns the share but must not be able to undo the teacher's lock.
  if (share.locked && !teacher && (role === "edit" || (role === "owner" && share.labId))) {
    role = "view";
  }
  const needsPin = share.access.pinHash !== null && !granted;
  const needsApproval = share.access.requireApproval && !granted;
  return {
    owner,
    teacher,
    granted,
    needsPin,
    needsApproval,
    role: needsPin || needsApproval ? null : role,
    pending: pending === 1,
  };
}

/** For actions of participants (download, fork, save, invite): PIN and approval must be done. */
export async function requireParticipant(
  ctx: Ctx,
  share: ShareRecord,
  session: Session,
): Promise<Access & { role: Role }> {
  const access = await accessOf(ctx, share, session);
  if (access.needsPin) throw new ApiError("pin_required", "This share needs a PIN");
  if (access.needsApproval) {
    throw new ApiError("pending_approval", "The owner has not approved you yet");
  }
  return access as Access & { role: Role };
}

export function requireOwner(share: ShareRecord, session: Session): void {
  if (share.ownerId !== session.clientId)
    throw new ApiError("forbidden", "Only the owner can do this");
}

/**
 * Counts wrong PINs per client and per IP (§8: 5 per client per 10 minutes) and throws
 * `rate_limited` once a limit is reached, even for the right PIN, so guessing cannot continue.
 */
export async function checkPin(
  ctx: Ctx,
  share: ShareRecord,
  session: Session,
  pin: string | undefined,
): Promise<void> {
  const hash = share.access.pinHash;
  if (hash === null) return;
  if (pin === undefined || pin === "") throw new ApiError("pin_required", "This share needs a PIN");
  const clientKey = apiKeys.pinFailsClient(share.id, session.clientId);
  const ipKey = apiKeys.pinFailsIp(share.id, session.ip);
  const [byClient, byIp] = await ctx.valkey.mget(clientKey, ipKey);
  if (Number(byClient ?? 0) >= PIN_MAX_ATTEMPTS || Number(byIp ?? 0) >= PIN_IP_MAX_ATTEMPTS) {
    const ttl = Math.max(1, await ctx.valkey.ttl(clientKey));
    ctx.metrics.rateLimited.inc({ bucket: "pin" });
    throw new ApiError("rate_limited", "Too many wrong PINs, try again later", {
      "Retry-After": String(ttl),
    });
  }
  if (await verifyPin(pin, hash)) {
    await ctx.valkey.del(clientKey);
    return;
  }
  const pipeline = ctx.valkey.multi();
  for (const key of [clientKey, ipKey]) {
    pipeline.incr(key);
    // EXPIRE NX: the window starts with the first wrong attempt and is not extended by later ones.
    pipeline.expire(key, PIN_ATTEMPT_WINDOW_SECONDS, "NX");
  }
  await pipeline.exec();
  throw new ApiError("pin_invalid", "Wrong PIN");
}

/** Remembers that the client passed PIN / approval, with the edit key it presented, if valid. */
export async function recordGrant(
  ctx: Ctx,
  share: ShareRecord,
  clientId: string,
  presentedKey: string | undefined,
): Promise<void> {
  const key = apiKeys.grants(share.id);
  const valid = !!presentedKey && safeEqual(presentedKey, share.access.editKey);
  const existing = await ctx.valkey.hget(key, clientId);
  if (existing !== null && !valid) return;
  await ctx.valkey.hset(key, clientId, valid ? (presentedKey as string) : (existing ?? ""));
  await ctx.valkey.expire(key, GRANT_TTL_SECONDS);
}

export function mintToken(
  ctx: Ctx,
  share: ShareRecord,
  session: Session,
  role: Role,
): Promise<string> {
  return signCollabToken(
    {
      shareId: share.id,
      clientId: session.clientId,
      name: displayName(session),
      color: session.color,
      role,
      exp: Math.floor(Date.now() / 1000) + COLLAB_TOKEN_TTL_SECONDS,
    },
    ctx.config.collabSecret,
  );
}

/** Seconds a join code should live: until the share expires, or forever for saved shares. */
export const codeTtlSeconds = (share: Pick<ShareRecord, "expiresAt">): number | null =>
  share.expiresAt === null
    ? null
    : Math.max(60, Math.ceil((share.expiresAt.getTime() - Date.now()) / 1000));

/** Called when someone joins: keeps the join code and the nearby entry alive. */
export async function noteActivity(ctx: Ctx, share: ShareRecord): Promise<void> {
  await Promise.all([
    touchCode(ctx, "share", share.joinCode, codeTtlSeconds(share)),
    refreshNearby(ctx, share),
  ]);
}

export function shareMeta(share: ShareRecord, clientId: string): ShareMeta {
  return {
    id: share.id,
    title: share.title,
    language: share.language,
    joinCode: share.joinCode,
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    lastActiveAt: share.lastActiveAt.toISOString(),
    expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
    saved: share.savedBy.includes(clientId),
    locked: share.locked,
    ...(share.labId ? { labId: share.labId } : {}),
    ...(share.forkOf ? { forkOf: share.forkOf } : {}),
  };
}

export function shareView(share: ShareRecord, session: Session, access: Access): GetShareResponse {
  const meta = shareMeta(share, session.clientId);
  return {
    ...meta,
    // Title and language stay hidden until the viewer is admitted.
    ...(access.role === null ? { title: "", language: "" } : {}),
    role: access.role,
    needsPin: access.needsPin,
    requireApproval: access.needsApproval,
    ...(access.owner
      ? {
          access: {
            default: share.access.default,
            hasPin: share.access.pinHash !== null,
            requireApproval: share.access.requireApproval,
            nearby: share.access.nearby,
            editKey: share.access.editKey,
          },
        }
      : {}),
  };
}

export { PENDING_TTL_SECONDS };
