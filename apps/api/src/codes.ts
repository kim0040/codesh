import { generateJoinCode, JOIN_CODE_COOLDOWN_SECONDS, keys } from "@codesh/shared";
import type { Ctx } from "./ctx.js";

export type CodeKind = "share" | "lab";

const MAX_TRIES = 50;

const keyOf = (kind: CodeKind, code: string) =>
  kind === "share" ? keys.code(code) : keys.labCode(code);

/**
 * KEYS: [own namespace, other namespace, cooldown]. A code must be free in both namespaces,
 * because `GET /api/codes/:code` resolves either, and must not be cooling down.
 * The cooldown key is written together with the code and outlives it by the cooldown period, so a
 * code that merely expires cannot be handed out again right away either.
 */
const ALLOCATE = `
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 0 end
redis.call('SET', KEYS[3], '1', 'EX', ARGV[3])
return 1
`;

/** Allocates a free 6 digit code with `SET NX EX` (§3) and returns it. */
export async function allocateCode(
  ctx: Ctx,
  kind: CodeKind,
  target: string,
  ttlSeconds: number,
): Promise<string> {
  const other: CodeKind = kind === "share" ? "lab" : "share";
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const code = ctx.randomCode?.() ?? generateJoinCode();
    const won = await ctx.valkey.eval(
      ALLOCATE,
      3,
      keyOf(kind, code),
      keyOf(other, code),
      keys.codeCooldown(code),
      target,
      String(ttl),
      String(ttl + JOIN_CODE_COOLDOWN_SECONDS),
    );
    if (won === 1) return code;
  }
  throw new Error("could not allocate a free join code");
}

/** Frees a code and blocks it for the cooldown period (§3). */
export async function releaseCode(ctx: Ctx, kind: CodeKind, code: string): Promise<void> {
  await ctx.valkey
    .multi()
    .del(keyOf(kind, code))
    .set(keys.codeCooldown(code), "1", "EX", JOIN_CODE_COOLDOWN_SECONDS)
    .exec();
}

/**
 * Keeps a code alive as long as its target: `null` pins it (saved shares never expire),
 * otherwise the code lives another `ttlSeconds`.
 */
export async function touchCode(
  ctx: Ctx,
  kind: CodeKind,
  code: string,
  ttlSeconds: number | null,
): Promise<void> {
  const key = keyOf(kind, code);
  if (ttlSeconds === null) {
    await ctx.valkey.persist(key);
    return;
  }
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  const pipeline = ctx.valkey.multi();
  // EXPIRE on a missing key is a no-op, so a code that already lapsed is not resurrected.
  pipeline.expire(key, ttl);
  pipeline.expire(keys.codeCooldown(code), ttl + JOIN_CODE_COOLDOWN_SECONDS);
  await pipeline.exec();
}

export async function resolveCode(
  ctx: Ctx,
  code: string,
): Promise<{ shareId: string } | { labId: string } | null> {
  const [shareId, labId] = await ctx.valkey.mget(keys.code(code), keys.labCode(code));
  if (shareId) return { shareId };
  if (labId) return { labId };
  return null;
}
