import { keys } from "@codesh/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { abuseKeys } from "./net.js";

export const WINDOW_SECONDS = 60;

/**
 * Fixed-window counters in Valkey (`rl:<ip>:<bucket>`, for IPv6 also `rl:<prefix>/64:<bucket>` at a
 * multiple of the limit, see `abuseKeys`). Throws `rate_limited` with a `Retry-After` header once
 * `limit` hits were made inside the current window.
 */
export async function rateLimit(
  ctx: Ctx,
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds = WINDOW_SECONDS,
): Promise<void> {
  for (const { key, factor } of abuseKeys(ip))
    await countHit(ctx, keys.rateLimit(key, bucket), bucket, limit, factor, windowSeconds);
}

async function countHit(
  ctx: Ctx,
  key: string,
  bucket: string,
  addressLimit: number,
  factor: number,
  windowSeconds: number,
): Promise<void> {
  const limit = addressLimit * factor;
  let result: [Error | null, unknown][] | null;
  try {
    result = await ctx.valkey.multi().incr(key).ttl(key).exec();
    const error = result?.find(([error]) => error)?.[0];
    if (error) throw error;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/OOM|command not allowed when used memory/i.test(error.message)
    )
      throw error;
    // Keep reads and health usable while noeviction refuses new counters. Bounded, conservative
    // local fallback; writes requiring a durable reservation still fail closed.
    const now = Date.now();
    for (const [key, entry] of ctx.fallbackRates)
      if (entry.until <= now) ctx.fallbackRates.delete(key);
    const entry = ctx.fallbackRates.get(key) ?? { count: 0, until: now + windowSeconds * 1000 };
    if (ctx.fallbackRates.size >= 10000 || ++entry.count > Math.min(limit, 30 * factor))
      throw new ApiError("rate_limited", "Too many requests", { "Retry-After": "60" });
    ctx.fallbackRates.set(key, entry);
    return;
  }
  const count = Number(result?.[0]?.[1] ?? 0);
  let ttl = Number(result?.[1]?.[1] ?? -1);
  if (ttl < 0) {
    // First hit, or a crash between INCR and EXPIRE left a counter that would never reset.
    await ctx.valkey.expire(key, windowSeconds);
    ttl = windowSeconds;
  }
  if (count > limit) {
    ctx.metrics.rateLimited.inc({ bucket: bucket.split(":")[0] ?? bucket });
    throw new ApiError("rate_limited", "Too many requests", { "Retry-After": String(ttl) });
  }
}

/**
 * Gives back one hit of `rateLimit`, for requests that turned out to be fine (a correct token).
 * Reserving first and releasing afterwards keeps the limit atomic against parallel guesses.
 */
export async function rateRelease(ctx: Ctx, ip: string, bucket: string): Promise<void> {
  for (const { key } of abuseKeys(ip))
    await ctx.valkey.eval(RELEASE, 1, keys.rateLimit(key, bucket));
}

const RELEASE = `
if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('DECR', KEYS[1]) <= 0 then
  redis.call('DEL', KEYS[1])
end
return 1
`;
