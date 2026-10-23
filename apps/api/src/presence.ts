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
import { displayName, type Session } from "./session.js";

/** Online users and nearby shares per network group (§7). */

const PRESENCE_WINDOW_MS = PRESENCE_USER_TTL_SECONDS * 1000;
const NEARBY_LIMIT = 50;
const SHARE_NET_TTL_SECONDS = 7 * 24 * 3600;

/** Marks the session online: ZSET entries for its net and for everyone, plus the user card. */
export async function touchPresence(ctx: Ctx, session: Session): Promise<void> {
  const now = Date.now();
  const card = keys.presenceUser(session.clientId);
  await ctx.valkey
    .multi()
    .zadd(keys.presenceNet(session.net), now, session.clientId)
    .zremrangebyscore(keys.presenceNet(session.net), "-inf", now - PRESENCE_WINDOW_MS)
    .zadd(apiKeys.presenceAll, now, session.clientId)
    .zremrangebyscore(apiKeys.presenceAll, "-inf", now - PRESENCE_WINDOW_MS)
    .hset(card, {
      name: displayName(session),
      color: session.color,
      net: session.net,
      room: session.room ?? "",
    })
    .expire(card, PRESENCE_USER_TTL_SECONDS)
    .exec();
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
export async function publishPresence(ctx: Ctx, net: string): Promise<void> {
  await ctx.publishNet(net, { event: "presence", data: await listPresence(ctx, net) });
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
