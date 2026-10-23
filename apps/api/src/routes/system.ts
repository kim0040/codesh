import { healthResponseSchema } from "@codesh/shared";
import type { Ctx } from "../ctx.js";
import type { App } from "./types.js";

export function systemRoutes(app: App, ctx: Ctx): void {
  app.get("/healthz", { schema: { response: { 200: healthResponseSchema } } }, async () => {
    await ctx.valkey.ping();
    return { ok: true as const };
  });

  app.get("/metrics", async (_request, reply) => {
    return reply
      .header("Content-Type", ctx.metrics.registry.contentType)
      .send(await ctx.metrics.registry.metrics());
  });
}
