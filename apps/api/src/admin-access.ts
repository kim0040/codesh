import { createHmac, randomBytes } from "node:crypto";
import { keys } from "@gachipad/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { ApiError, forbidden, notFound } from "./errors.js";
import { cidrContains, parseIp } from "./net.js";
import { rateLimit } from "./rate.js";
import { clientIp } from "./session.js";

const auditSalt = randomBytes(32);
// Shared across API replicas and client addresses. Reserve before comparison, refund successes.
// Burst: 100 failures; refill: 100 per 10 minutes; depletion pauses comparisons for 30 seconds.
const budgetKey = () => keys.rateLimit("global", "admin-token-budget");
const TAKE_BUDGET = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at', 'pause')
local tokens = math.min(100, (tonumber(state[1]) or 100) + math.max(0, now - (tonumber(state[2]) or now)) / 6000)
local pause = tonumber(state[3]) or 0
if pause > now then return math.ceil((pause - now) / 1000) end
if tokens < 1 then pause = now + 30000 else tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now, 'pause', pause)
redis.call('EXPIRE', KEYS[1], 600)
if pause > now then return 30 end
return 0
`;
const REFUND_BUDGET = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], 'tokens', math.min(100, tonumber(redis.call('HGET', KEYS[1], 'tokens')) + 1))
end
return 1
`;
/** Runs onRequest, before sessions, settings, general rate limits or body validation. */
export async function adminAccess(
  ctx: Ctx,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply
    .header("Cache-Control", "no-store, private")
    .header("Vary", "Authorization")
    .header("Pragma", "no-cache");
  const ip = clientIp(ctx, request);
  const parsed = parseIp(ip);
  if (
    ctx.config.adminToken === "" ||
    (ctx.adminAllowed.length > 0 &&
      (!parsed || !ctx.adminAllowed.some((cidr) => cidrContains(cidr, parsed))))
  )
    throw notFound("Not found");
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const restricted =
    ctx.adminAllowed.length > 0 && !ctx.adminAllowed.some((cidr) => cidr.prefix === 0);
  if (!restricted) {
    const retry = Number(await ctx.valkey.eval(TAKE_BUDGET, 1, budgetKey()));
    if (retry > 0)
      throw new ApiError("rate_limited", "Admin token comparisons paused", {
        "Retry-After": String(retry),
      });
  }
  // The per-address bucket alone cannot lock out a legitimate administrator behind the same NAT.
  // Explicitly allowlisted addresses also remain available during a global pause.
  if (safeEqual(token, ctx.config.adminToken)) {
    if (!restricted) await ctx.valkey.eval(REFUND_BUDGET, 1, budgetKey());
    return;
  }
  ctx.diagnostics.record("admin_login_failed", {}, "warn");
  const now = Date.now();
  if (now - ctx.adminAuditAt >= 60_000 && !ctx.adminAuditPending) {
    ctx.adminAuditAt = now;
    ctx.adminAuditPending = true;
    void ctx.stores.audit
      .append({
        at: new Date(now),
        actor: "00000000-0000-4000-8000-000000000000",
        ip: `hash:${createHmac("sha256", auditSalt).update(ip).digest("hex").slice(0, 12)}`,
        action: "admin.login_failed",
        detail: { sampled: true },
      })
      .catch(() => undefined)
      .finally(() => {
        ctx.adminAuditPending = false;
      });
  }
  await rateLimit(ctx, ip, "admin-login", ctx.config.rateLimit.loginPerMinute);
  throw forbidden("Invalid admin token");
}
