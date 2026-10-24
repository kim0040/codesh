import {
  apiKeys,
  keys,
  NEARBY_ITEM_TTL_SECONDS,
  type NearbyItem,
  PRESENCE_USER_TTL_SECONDS,
  type PresenceUser,
  type ShareRecord,
} from "@codesh/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { networkKey } from "./net.js";
import { displayName, type Session } from "./session.js";

/** Online users and nearby shares per network group (§7). */

const PRESENCE_WINDOW_MS = PRESENCE_USER_TTL_SECONDS * 1000;
const NEARBY_LIMIT = 50;
const SHARE_NET_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Marks the session online: ZSET entries for its net and for everyone, plus the user card.
 * Name and color come from the stored profile, not from `session`: an SSE stream keeps the
 * session it opened with, and must not turn a rename back into the old name.
 */
export async function touchPresence(ctx: Ctx, session: Session): Promise<void> {
  const now = Date.now();
  const card = keys.presenceUser(session.clientId);
  const profile = await ctx.valkey.hgetall(apiKeys.profile(session.clientId));
  const current = { ...session, name: profile.name || session.name };
  const accepted = await ctx.valkey.eval(
    TOUCH_PRESENCE,
    3,
    keys.presenceNet(session.net),
    apiKeys.presenceAll,
    card,
    now,
    PRESENCE_WINDOW_MS,
    session.clientId,
    ctx.config.limits.PRESENCE_MAX_PER_NET,
    displayName(current),
    profile.color || session.color,
    session.net,
    session.room ?? "",
    networkKey(session.ip),
  );
  if (Number(accepted) !== 1)
    throw new ApiError("rate_limited", "This network group has reached its presence capacity", {
      "Retry-After": "60",
    });
}

export async function removePresence(ctx: Ctx, session: Session): Promise<void> {
  await ctx.valkey
    .multi()
    .zrem(keys.presenceNet(session.net), session.clientId)
    .zrem(apiKeys.presenceAll, session.clientId)
    .del(keys.presenceUser(session.clientId))
    .exec();
}

export async function listPresence(ctx: Ctx, net: string): Promise<PresenceUser[]> {
  const ids = await ctx.valkey.zrangebyscore(
    keys.presenceNet(net),
    Date.now() - PRESENCE_WINDOW_MS,
    "+inf",
    "LIMIT",
    0,
    ctx.config.limits.PRESENCE_MAX_PER_NET,
  );
  if (ids.length === 0) return [];
  const pipeline = ctx.valkey.pipeline();
  for (const id of ids) pipeline.hgetall(keys.presenceUser(id));
  const cards = (await pipeline.exec()) ?? [];
  const users: PresenceUser[] = [];
  for (const [index, id] of ids.entries()) {
    const card = (cards[index]?.[1] ?? {}) as Record<string, string>;
    // A missing card means the user went offline between the two reads.
    if (!card.name || !card.color) continue;
    users.push({ clientId: id, name: card.name, color: card.color, room: card.room || null });
  }
  return users.sort((a, b) => a.name.localeCompare(b.name) || a.clientId.localeCompare(b.clientId));
}

/** Pushes the full presence list of `net` to every open SSE stream in it (§9.1). */
export function publishPresence(ctx: Ctx, net: string): Promise<void> {
  const current = ctx.presencePublishes.get(net);
  if (current) return current;
  const pending = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      void ctx.publishNet(net, { event: "presence", data: [] }).then(resolve, reject);
    }, 100);
  }).finally(() => {
    if (ctx.presencePublishes.get(net) === pending) ctx.presencePublishes.delete(net);
  });
  ctx.presencePublishes.set(net, pending);
  return pending;
}

/** Adds a share to the nearby list of `net` and seeds its card until collab keeps it fresh. */
export async function announceShare(
  ctx: Ctx,
  share: ShareRecord,
  net: string,
  preview: string,
): Promise<void> {
  if (!share.access.nearby) return;
  const item = keys.nearbyItem(share.id);
  const pipeline = ctx.valkey.multi();
  pipeline.zadd(keys.nearbyNet(net), Date.now(), share.id);
  pipeline.set(apiKeys.shareNet(share.id), net, "EX", SHARE_NET_TTL_SECONDS);
  await pipeline.exec();
  // Collab owns the card once the document is live; only seed it when it does not exist yet.
  if (!(await ctx.valkey.exists(item))) {
    await ctx.valkey
      .multi()
      .hset(item, {
        id: share.id,
        title: share.title,
        language: share.language,
        participants: "0",
        preview,
      })
      .expire(item, NEARBY_ITEM_TTL_SECONDS)
      .exec();
  }
}

/** Keeps a share in its nearby list while people still join it. */
export async function refreshNearby(ctx: Ctx, share: ShareRecord): Promise<void> {
  if (!share.access.nearby) return;
  const net = await ctx.valkey.get(apiKeys.shareNet(share.id));
  if (!net) return;
  await ctx.valkey
    .multi()
    .zadd(keys.nearbyNet(net), Date.now(), share.id)
    .expire(apiKeys.shareNet(share.id), SHARE_NET_TTL_SECONDS)
    .expire(keys.nearbyItem(share.id), NEARBY_ITEM_TTL_SECONDS)
    .exec();
}

export async function removeNearby(ctx: Ctx, shareId: string): Promise<void> {
  const net = await ctx.valkey.get(apiKeys.shareNet(shareId));
  const pipeline = ctx.valkey.multi();
  if (net) pipeline.zrem(keys.nearbyNet(net), shareId);
  pipeline.del(keys.nearbyItem(shareId), apiKeys.shareNet(shareId));
  await pipeline.exec();
}

/** Shares announced in `net` whose card is still alive and whose record still exists. */
export async function listNearby(ctx: Ctx, net: string): Promise<NearbyItem[]> {
  const zset = keys.nearbyNet(net);
  const ids = await ctx.valkey.zrevrange(zset, 0, NEARBY_LIMIT - 1);
  if (ids.length === 0) return [];
  const pipeline = ctx.valkey.pipeline();
  for (const id of ids) pipeline.hgetall(keys.nearbyItem(id));
  const cards = (await pipeline.exec()) ?? [];
  const alive = await ctx.stores.shares.existing(ids);
  const items: NearbyItem[] = [];
  const stale: string[] = [];
  for (const [index, id] of ids.entries()) {
    const card = (cards[index]?.[1] ?? {}) as Record<string, string>;
    // An empty hash means the card expired: nobody has touched the share for a minute.
    if (Object.keys(card).length === 0 || !alive.has(id)) {
      stale.push(id);
      continue;
    }
    items.push({
      id,
      title: card.title ?? "",
      language: card.language ?? "",
      participants: Number(card.participants ?? 0) || 0,
      preview: card.preview ?? "",
    });
  }
  if (stale.length > 0) await ctx.valkey.zrem(zset, ...stale);
  return items;
}

/**
 * `listNearby` for the refresh ticks of SSE streams: every stream of a network group asks for the
 * same list, so it is computed once per `nearbyCacheMs` (and shared while in flight) instead of
 * once per stream and tick, which would be a MongoDB query per stream every 20 seconds.
 */
export function listNearbyCached(ctx: Ctx, net: string): Promise<NearbyItem[]> {
  const now = Date.now();
  const hit = ctx.nearbyCache.get(net);
  if (hit && now - hit.at < ctx.nearbyCacheMs) return hit.list;
  for (const [key, entry] of ctx.nearbyCache) {
    if (now - entry.at >= ctx.nearbyCacheMs) ctx.nearbyCache.delete(key);
  }
  const list = listNearby(ctx, net);
  const entry = { at: now, list };
  ctx.nearbyCache.set(net, entry);
  // A failed lookup is not remembered.
  list.catch(() => {
    if (ctx.nearbyCache.get(net) === entry) ctx.nearbyCache.delete(net);
  });
  return list;
}

const TOUCH_PRESENCE = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl * 2)
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - ttl)
redis.call('HSET', KEYS[3], 'name', ARGV[5], 'color', ARGV[6], 'net', ARGV[7], 'room', ARGV[8], 'networkKey', ARGV[9])
redis.call('PEXPIRE', KEYS[3], ttl)
return 1
`;

export function listPresenceCached(ctx: Ctx, net: string): Promise<PresenceUser[]> {
  const now = Date.now();
  const cached = ctx.presenceCache.get(net);
  if (cached && now - cached.at < 100) return cached.list;
  for (const [key, entry] of ctx.presenceCache)
    if (now - entry.at >= 100) ctx.presenceCache.delete(key);
  const list = listPresence(ctx, net);
  const entry = { at: now, list };
  ctx.presenceCache.set(net, entry);
  list.catch(() => {
    if (ctx.presenceCache.get(net) === entry) ctx.presenceCache.delete(net);
  });
  return list;
}
