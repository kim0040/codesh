import {
  type AdminOverview,
  type AdminSecurity,
  type AdminShare,
  apiKeys,
  DIAGNOSTIC_CAPS,
  DIAGNOSTIC_SERVER_CAPS,
  type DiagnosticSnapshot,
  okResponseSchema,
  PRESENCE_USER_TTL_SECONDS,
  type ServerDiagnosticBundle,
  shareIdSchema,
  shareParamsSchema,
} from "@gachipad/shared";
import { diagnosticShareRef } from "@gachipad/storage";
import { z } from "zod";
import { codeFailureStatus } from "../codes.js";
import { randomKey } from "../crypto.js";
import type { Ctx } from "../ctx.js";
import { notFound } from "../errors.js";
import { deleteShare } from "../shares.js";
import { type App, OK } from "./types.js";

async function health(ctx: Ctx, collabAt: number): Promise<AdminOverview["health"]> {
  const [mongo, valkey] = await Promise.allSettled([ctx.stores.settings.get(), ctx.valkey.ping()]);
  return {
    mongo: mongo.status === "fulfilled",
    valkey: valkey.status === "fulfilled",
    collab: Date.now() - collabAt < 20_000 ? "healthy" : "unknown",
  };
}
/** Rolling 24 h at minute resolution, independent of loop deduplication/eviction. */
const errors24h = (snapshots: DiagnosticSnapshot[]) =>
  snapshots
    .flatMap((s) => s.errorMinutes ?? [])
    .filter(([minute]) => minute >= Math.floor(Date.now() / 60_000) - 1440)
    .reduce((n, [, count]) => n + count, 0);

export function adminDiagnosticRoutes(app: App, ctx: Ctx): void {
  app.get("/api/admin/overview", async (): Promise<AdminOverview> => {
    const { snapshots } = await ctx.diagnostics.recent();
    const cutoff = Math.floor(Date.now() / 60_000) - 4;
    const identities = snapshots
      .filter((s) => s.source === "api")
      .flatMap((s) => s.clientIdentityMinutes ?? [])
      .filter(([minute]) => minute >= cutoff)
      .reduce<[number, number]>(
        ([total, unknown], [, count, misses]) => [total + count, unknown + misses],
        [0, 0],
      );
    const live = snapshots.filter(
      (s) => s.source === "collab" && Date.now() - Date.parse(s.at) < 20_000,
    );
    const [summary, onlineUsers, uploads] = await Promise.all([
      ctx.stores.shares.adminSummary(),
      ctx.valkey.zcount(apiKeys.presenceAll, Date.now() - PRESENCE_USER_TTL_SECONDS * 1000, "+inf"),
      ctx.valkey.zrangebyscore(apiKeys.uploadsIndex, Date.now(), "+inf"),
    ]);
    return {
      ...summary,
      onlineUsers,
      documents: live.reduce((n, s) => n + s.documents, 0),
      connections: live.reduce((n, s) => n + s.connections, 0),
      storageBytes: uploads.reduce((n, m) => n + (Number(m.slice(m.lastIndexOf(":") + 1)) || 0), 0),
      quotaBytes: ctx.config.limits.UPLOAD_STORAGE_MAX_BYTES,
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
      version: ctx.version,
      errors24h: errors24h(snapshots),
      unknownClientIdentity:
        ctx.config.network === "public" && (identities[1] ?? 0) > (identities[0] ?? 0) * 0.05,
      health: await health(ctx, Math.max(0, ...live.map((s) => Date.parse(s.at)))),
    };
  });
  const query = z.object({
    level: z.enum(["warn", "error"]).optional(),
    source: z.enum(["api", "collab"]).optional(),
    since: z.iso.datetime().optional(),
  });
  app.get("/api/admin/diagnostics", { schema: { querystring: query } }, async (request) => {
    const { events } = await ctx.diagnostics.recent();
    return events
      .filter(
        (e) =>
          (!request.query.level || request.query.level === e.level) &&
          (!request.query.source || request.query.source === e.source) &&
          (!request.query.since || e.lastAt >= request.query.since),
      )
      .slice(0, DIAGNOSTIC_SERVER_CAPS.exportEvents);
  });
  app.get(
    "/api/admin/diagnostics/export",
    async (_request, reply): Promise<ServerDiagnosticBundle> => {
      const { events, snapshots } = await ctx.diagnostics.recent();
      const settings = ctx.settingsSnapshot();
      reply.header(
        "Content-Disposition",
        `attachment; filename="gachipad-server-diagnostics-${ctx.version.replace(/[^\w.-]/g, "_")}.json"`,
      );
      return {
        format: 1,
        header: `gachipad server diagnostics v${ctx.version}: operational categories, short per-process breadcrumb timelines, redacted source frames and counts. No document content, credentials, URLs or client addresses. Source maps for this version are on the GitHub release page as gachipad-web-sourcemaps-${ctx.version}.tar.gz.`,
        exportedAt: new Date().toISOString(),
        version: ctx.version,
        uptimeSeconds: Math.floor((Date.now() - ctx.startedAt) / 1000),
        caps: DIAGNOSTIC_CAPS,
        serverCaps: DIAGNOSTIC_SERVER_CAPS,
        health: await health(
          ctx,
          Math.max(
            0,
            ...snapshots.filter((s) => s.source === "collab").map((s) => Date.parse(s.at)),
          ),
        ),
        config: {
          storage: ctx.config.storage,
          ADMIN_TOKEN_SET: ctx.config.adminToken !== "",
          SESSION_SECRET_SET: ctx.config.sessionSecret !== "",
          COLLAB_SECRET_SET: ctx.config.collabSecret !== "",
          DATABASE_URL_SET: ctx.config.databaseUrlSet,
          VALKEY_URL_SET: ctx.config.valkeyUrl !== "",
          OIDC_CLIENT_SECRET_SET: settings
            ? typeof settings.auth.oidc?.clientSecret === "string" &&
              settings.auth.oidc.clientSecret !== ""
            : "unknown",
          LDAP_BIND_PASSWORD_SET: settings
            ? typeof settings.auth.ldap?.bindPassword === "string" &&
              settings.auth.ldap.bindPassword !== ""
            : "unknown",
          PUBLIC_URL_SET: ctx.config.publicUrl !== "",
          ADMIN_ALLOW_CIDR_SET: ctx.config.adminAllowCidr.length > 0,
          TRUST_PROXY_SET: ctx.config.trustProxy.length > 0,
          UPDATE_CHECK: ctx.config.update.enabled,
          loginPerMinute: ctx.config.rateLimit.loginPerMinute,
          apiPerMinute: ctx.config.rateLimit.apiPerMinute,
        },
        counters: { errors24h: errors24h(snapshots) },
        processes: snapshots.map(({ slot, source, bootId, breadcrumbs }) => ({
          slot,
          source,
          bootId,
          breadcrumbs,
        })),
        events: events.slice(0, DIAGNOSTIC_SERVER_CAPS.exportEvents),
      };
    },
  );
  app.get(
    "/api/admin/security",
    async (): Promise<AdminSecurity> => ({
      codeFailures: await codeFailureStatus(ctx),
      cidrRestricted: ctx.config.adminAllowCidr.length > 0,
      proxyRestricted: ctx.config.trustProxy.length > 0,
      loginPerMinute: ctx.config.rateLimit.loginPerMinute,
      apiPerMinute: ctx.config.rateLimit.apiPerMinute,
      failedLogins: (await ctx.diagnostics.recent()).events.filter(
        (e) => e.kind === "admin_login_failed",
      ),
    }),
  );
  app.get(
    "/api/admin/shares",
    {
      schema: {
        querystring: z.object({
          search: z.string().max(100).default(""),
          before: z.iso.datetime().optional(),
          beforeId: shareIdSchema.optional(),
        }),
      },
    },
    async (request): Promise<AdminShare[]> => {
      const shares = await ctx.stores.shares.adminList(
        request.query.search,
        request.query.before ? new Date(request.query.before) : undefined,
        request.query.beforeId,
      );
      const live = (await ctx.diagnostics.recent()).snapshots.filter(
        (s) => s.source === "collab" && Date.now() - Date.parse(s.at) < 20_000,
      );
      return Promise.all(
        shares.map(async (s) => ({
          id: s.id,
          title: s.title,
          language: s.language,
          ownerKind: s.labId
            ? "lab"
            : (await ctx.valkey.hexists(apiKeys.identity(s.ownerId), "subject"))
              ? "signed_in"
              : "unknown",
          saved: s.saved,
          createdAt: s.createdAt.toISOString(),
          lastActiveAt: s.lastActiveAt.toISOString(),
          expiresAt: s.expiresAt?.toISOString() ?? null,
          sizeBytes: s.sizeBytes,
          locked: s.locked,
          participants:
            live.length &&
            !live.some(
              (snapshot) =>
                snapshot.documents > DIAGNOSTIC_SERVER_CAPS.participants &&
                snapshot.participants?.[diagnosticShareRef(ctx.config.collabSecret, s.id)] ===
                  undefined,
            )
              ? live.reduce(
                  (n, snapshot) =>
                    n +
                    (snapshot.participants?.[diagnosticShareRef(ctx.config.collabSecret, s.id)] ??
                      0),
                  0,
                )
              : null,
        })),
      );
    },
  );
  for (const action of ["lock", "unlock", "delete"] as const) {
    app.post(
      `/api/admin/shares/:id/${action}`,
      { schema: { params: shareParamsSchema, response: { 200: okResponseSchema } } },
      async (request) => {
        const share = await ctx.stores.shares.get(request.params.id);
        if (!share) throw notFound("Not found");
        if (action === "lock" || action === "unlock") {
          await ctx.stores.shares.update(share.id, {
            locked: action === "lock",
            access: { generation: randomKey() },
          });
          await ctx.publishPerm(share.id, "lock");
        } else {
          await deleteShare(ctx, share);
        }
        await ctx.audit(request, `admin.share.${action}`, share.id);
        return OK;
      },
    );
  }
}
