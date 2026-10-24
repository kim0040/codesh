import { healthResponseSchema, versionResponseSchema } from "@codesh/shared";
import type { Ctx } from "../ctx.js";
import type { App } from "./types.js";

export function systemRoutes(app: App, ctx: Ctx): void {
  app.get("/healthz", { schema: { response: { 200: healthResponseSchema } } }, async () => {
    await ctx.valkey.ping();
    return { ok: true as const };
  });

  /** Ready to serve: Valkey answers and the stores can be read (deploy/update.sh waits for it). */
  app.get("/readyz", { schema: { response: { 200: healthResponseSchema } } }, async () => {
    await ctx.valkey.ping();
    await ctx.stores.settings.get();
    return { ok: true as const };
  });

  /** Public: open tabs compare it with their own build to offer a reload after an update. */
  app.get(
    "/api/version",
    { schema: { response: { 200: versionResponseSchema } } },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { version: ctx.updates.version };
    },
  );

  app.get("/metrics", async (_request, reply) => {
    return reply
      .header("Content-Type", ctx.metrics.registry.contentType)
      .send(await ctx.metrics.registry.metrics());
  });
}
