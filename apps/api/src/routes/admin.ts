import {
  adminUpdateResponseSchema,
  apiKeys,
  auditQuerySchema,
  auditResponseSchema,
  getSettingsResponseSchema,
  MAX_TEMPLATES_TOTAL_BYTES,
  PRESENCE_USER_TTL_SECONDS,
  putSettingsBodySchema,
  type Settings,
  statsResponseSchema,
} from "@gachipad/shared";
import { ldapConfigSchema, oidcConfigSchema } from "../auth/adapters.js";
import type { Ctx } from "../ctx.js";
import { ApiError, invalid } from "../errors.js";
import { isValidCidr } from "../net.js";
import { adminDiagnosticRoutes } from "./admin-diagnostics.js";
import type { App } from "./types.js";

/**
 * Request size of `PUT /api/admin/settings`: the template files, which JSON escaping can grow to
 * six bytes per byte (`\u0001`), plus room for the other settings. Fastify's default is 1 MiB.
 */
const SETTINGS_BODY_LIMIT = MAX_TEMPLATES_TOTAL_BYTES * 6 + 1024 * 1024;

/** "Check now" asks GitHub at most once per this many seconds for the whole deployment. */
const MANUAL_CHECK_COOLDOWN_SECONDS = 60;

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
  adminDiagnosticRoutes(app, ctx);
  // The application onRequest hook authenticates all admin routes before validation.

  app.get(
    "/api/admin/settings",
    { schema: { response: { 200: getSettingsResponseSchema } } },
    async () => ctx.stores.settings.get(),
  );

  app.put(
    "/api/admin/settings",
    {
      bodyLimit: SETTINGS_BODY_LIMIT,
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

  app.get("/api/admin/stats", { schema: { response: { 200: statsResponseSchema } } }, async () => {
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
  });

  const updateResponse = async () => {
    const { repo, channel } = ctx.config.update;
    return {
      ...(await ctx.updates.state()),
      repo,
      channel,
      releasesUrl: `https://github.com/${repo}/releases`,
      updater: await ctx.updates.updaterStatus(),
    };
  };

  app.get(
    "/api/admin/update",
    { schema: { response: { 200: adminUpdateResponseSchema } } },
    updateResponse,
  );

  app.post(
    "/api/admin/update/check",
    { schema: { response: { 200: adminUpdateResponseSchema } } },
    async () => {
      if (ctx.updates.enabled) {
        const fresh = await ctx.valkey.set(
          apiKeys.updateManual,
          "1",
          "EX",
          MANUAL_CHECK_COOLDOWN_SECONDS,
          "NX",
        );
        if (fresh !== "OK") {
          const ttl = await ctx.valkey.ttl(apiKeys.updateManual);
          throw new ApiError("rate_limited", "Checked a moment ago", {
            "Retry-After": String(ttl > 0 ? ttl : MANUAL_CHECK_COOLDOWN_SECONDS),
          });
        }
        await ctx.updates.check(true);
      }
      return updateResponse();
    },
  );
}
