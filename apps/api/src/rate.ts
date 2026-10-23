import { keys } from "@codesh/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";

export const WINDOW_SECONDS = 60;

/**
 * Fixed-window counter in Valkey (`rl:<ip>:<bucket>`). Throws `rate_limited` with a `Retry-After`
 * header once `limit` hits were made inside the current window.
 */
export async function rateLimit(
  ctx: Ctx,
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds = WINDOW_SECONDS,
): Promise<void> {
  const key = keys.rateLimit(ip, bucket);
  const result = await ctx.valkey.multi().incr(key).ttl(key).exec();
  const count = Number(result?.[0]?.[1] ?? 0);
  let ttl = Number(result?.[1]?.[1] ?? -1);
  if (ttl < 0) {
    // First hit, or a crash between INCR and EXPIRE left a counter that would never reset.
    await ctx.valkey.expire(key, windowSeconds);
    ttl = windowSeconds;
  }
  if (count > limit) {
    ctx.metrics.rateLimited.inc({ bucket });
    throw new ApiError("rate_limited", "Too many requests", { "Retry-After": String(ttl) });
  }
}
