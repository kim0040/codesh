import { generateJoinCode, JOIN_CODE_COOLDOWN_SECONDS, keys } from "@gachipad/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { abuseKeys } from "./net.js";

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
  ip = "unknown",
): Promise<{ shareId: string } | { labId: string } | null> {
  const budget = keys.rateLimit("global", "code-failures");
  const address = abuseKeys(ip).at(-1)?.key ?? "unknown";
  const recentMiss = keys.rateLimit(address, "code-recent-miss");
  let window = 0;
  if (ctx.config.network === "public") {
    const [admitted, audit] = (await ctx.valkey.eval(
      RESERVE_LOOKUP,
      2,
      budget,
      recentMiss,
      ctx.config.codeFailureBudgetPerMinute,
    )) as [number, number];
    if (admitted < 0) {
      ctx.diagnostics.record("rate_limit");
      ctx.metrics.rateLimited.inc({ bucket: "code-global" });
      if (audit === 1)
        await ctx.stores.audit
          .append({
            at: new Date(),
            actor: "00000000-0000-4000-8000-000000000000",
            ip: "global",
            action: "code.lookup_limited",
            detail: { budget: ctx.config.codeFailureBudgetPerMinute },
          })
          .catch(() => undefined);
      throw new ApiError("rate_limited", "Join-code lookups paused; try again shortly", {
        "Retry-After": String(-admitted),
      });
    }
    window = admitted;
  }
  const [shareId, labId] = await ctx.valkey.mget(keys.code(code), keys.labCode(code));
  if (ctx.config.network === "public" && !shareId && !labId)
    await ctx.valkey.set(recentMiss, "1", "EX", 600);
  if (window && (shareId || labId)) await ctx.valkey.eval(REFUND_LOOKUP, 1, budget, window);
  if (shareId) return { shareId };
  if (labId) return { labId };
  return null;
}

// Reserve before the lookup, refund hits. One Valkey clock and atomic admission across replicas
// bound parallel guesses; matching the window on refund prevents crossing-window undercounts.
const RESERVE_LOOKUP = `
if redis.call('EXISTS', KEYS[2]) == 0 then return {0, 0} end
local now = tonumber(redis.call('TIME')[1])
local window = math.floor(now / 60) + 1
local state = redis.call('HMGET', KEYS[1], 'window', 'count', 'logged')
local count = tonumber(state[2]) or 0
if tonumber(state[1]) ~= window then
  count = 0
  redis.call('HSET', KEYS[1], 'window', window, 'count', 0, 'logged', 0)
end
redis.call('EXPIRE', KEYS[1], 120)
if count >= tonumber(ARGV[1]) then
  local log = tonumber(redis.call('HGET', KEYS[1], 'logged')) == 0 and 1 or 0
  redis.call('HSET', KEYS[1], 'logged', 1)
  return {-(60 - now % 60), log}
end
redis.call('HINCRBY', KEYS[1], 'count', 1)
return {window, 0}
`;

const REFUND_LOOKUP = `
if tonumber(redis.call('HGET', KEYS[1], 'window')) == tonumber(ARGV[1]) then
  redis.call('HINCRBY', KEYS[1], 'count', -1)
end
return 1
`;

/** Read with Valkey's clock so expired windows are never shown as exhausted. */
export async function codeFailureStatus(
  ctx: Ctx,
): Promise<{ count: number; limit: number; exhausted: boolean }> {
  const limit = ctx.config.codeFailureBudgetPerMinute;
  const count =
    ctx.config.network === "public"
      ? Number(
          await ctx.valkey.eval(
            `
local window = math.floor(tonumber(redis.call('TIME')[1]) / 60) + 1
local state = redis.call('HMGET', KEYS[1], 'window', 'count')
if tonumber(state[1]) ~= window then return 0 end
return tonumber(state[2]) or 0
`,
            1,
            keys.rateLimit("global", "code-failures"),
          ),
        )
      : 0;
  return { count, limit, exhausted: count >= limit };
}
