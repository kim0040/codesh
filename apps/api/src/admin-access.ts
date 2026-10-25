import { createHmac, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "./crypto.js";
import type { Ctx } from "./ctx.js";
import { forbidden, notFound } from "./errors.js";
import { cidrContains, parseIp } from "./net.js";
import { rateLimit } from "./rate.js";
import { clientIp } from "./session.js";

const auditSalt = randomBytes(32);
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
  // Constant-time SHA-256 comparison happens even after a guessed-token bucket is exhausted.
  // A neighbour behind the same NAT cannot lock out a legitimate administrator.
  if (safeEqual(token, ctx.config.adminToken)) return;
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
