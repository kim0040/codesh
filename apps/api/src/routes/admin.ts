import {
  apiKeys,
  auditQuerySchema,
  auditResponseSchema,
  getSettingsResponseSchema,
  PRESENCE_USER_TTL_SECONDS,
  putSettingsBodySchema,
  type Settings,
  statsResponseSchema,
} from "@codesh/shared";
import type { FastifyRequest } from "fastify";
import { ldapConfigSchema, oidcConfigSchema } from "../auth/adapters.js";
import { safeEqual } from "../crypto.js";
import type { Ctx } from "../ctx.js";
import { forbidden, invalid, notFound } from "../errors.js";
import { isValidCidr } from "../net.js";
import { rateLimit, rateRelease } from "../rate.js";
import type { App } from "./types.js";

/** Rejects settings the API could not act on, and normalises the login provider blocks. */
function validateSettings(settings: Settings): Settings {
  const names = new Set<string>();
  for (const room of settings.rooms) {
    if (names.has(room.name)) throw invalid(`Duplicate room name: ${room.name}`);
    names.add(room.name);
    for (const cidr of room.cidrs) {
      if (!isValidCidr(cidr)) throw invalid(`Invalid CIDR in room ${room.name}: ${cidr}`);
    }
  }
  const { oidc, ldap } = settings.auth;
  const parsedOidc = oidc === null ? null : oidcConfigSchema.safeParse(oidc);
  if (parsedOidc && !parsedOidc.success) throw invalid("auth.oidc is invalid");
  const parsedLdap = ldap === null ? null : ldapConfigSchema.safeParse(ldap);
  if (parsedLdap && !parsedLdap.success) throw invalid("auth.ldap is invalid");
  return {
    ...settings,
    auth: {
      oidc: parsedOidc?.success ? parsedOidc.data : null,
      ldap: parsedLdap?.success ? parsedLdap.data : null,
    },
  };
}

export function adminRoutes(app: App, ctx: Ctx): void {
  /** `Authorization: Bearer <ADMIN_TOKEN>`; an empty ADMIN_TOKEN switches the admin API off. */
  const adminOnly = async (request: FastifyRequest) => {
    const expected = ctx.config.adminToken;
    if (expected === "") throw notFound("Not found");
    // Guessing the token is brute force like any other: the attempt is reserved before the check
    // (so parallel guesses are counted) and given back when the token is right, so the console's
    // own requests do not use up the limit.
    const { ip } = request.session;
    await rateLimit(ctx, ip, "login", ctx.config.rateLimit.loginPerMinute);
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!safeEqual(token, expected)) throw forbidden("Invalid admin token");
    await rateRelease(ctx, ip, "login");
  };

  app.get(
    "/api/admin/settings",
    { preHandler: adminOnly, schema: { response: { 200: getSettingsResponseSchema } } },
    async () => ctx.stores.settings.get(),
  );

  app.put(
    "/api/admin/settings",
    {
      preHandler: adminOnly,
      schema: { body: putSettingsBodySchema, response: { 200: getSettingsResponseSchema } },
    },
    async (request) => {
      const settings = validateSettings(request.body);
      await ctx.stores.settings.put(settings);
      ctx.invalidateSettings();
      await ctx.audit(request, "admin.settings", undefined, { audit: settings.audit.enabled });
      return settings;
    },
  );

  app.get(
    "/api/admin/audit",
    {
      preHandler: adminOnly,
      schema: { querystring: auditQuerySchema, response: { 200: auditResponseSchema } },
    },
    async (request) => {
      const { limit, before } = request.query;
      const entries = await ctx.stores.audit.list({
        limit,
        ...(before ? { before: new Date(before) } : {}),
      });
      return entries.map((entry) => ({
        at: entry.at.toISOString(),
        actor: entry.actor,
        ip: entry.ip,
        action: entry.action,
        ...(entry.shareId ? { shareId: entry.shareId } : {}),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      }));
    },
  );

  app.get(
    "/api/admin/stats",
    { preHandler: adminOnly, schema: { response: { 200: statsResponseSchema } } },
    async () => {
      const now = Date.now();
      // The indexes are scored by expiry; drop what has expired before counting.
      const result = await ctx.valkey
        .multi()
        .zremrangebyscore(apiKeys.sharesIndex, "-inf", String(now))
        .zcard(apiKeys.sharesIndex)
        .zremrangebyscore(apiKeys.labsIndex, "-inf", String(now))
        .zcard(apiKeys.labsIndex)
        .zcount(apiKeys.presenceAll, String(now - PRESENCE_USER_TTL_SECONDS * 1000), "+inf")
        .zremrangebyscore(apiKeys.uploadsIndex, "-inf", String(now))
        .zrange(apiKeys.uploadsIndex, "0", "-1")
        .exec();
      const value = (index: number) => result?.[index]?.[1];
      const uploads = (value(6) as string[] | undefined) ?? [];
      return {
        shares: Number(value(1) ?? 0),
        labs: Number(value(3) ?? 0),
        onlineUsers: Number(value(4) ?? 0),
        uploadBytes: uploads.reduce(
          (sum, member) => sum + (Number(member.slice(member.lastIndexOf(":") + 1)) || 0),
          0,
        ),
      };
    },
  );
}
