import { codeParamsSchema, codeResolveResponseSchema } from "@codesh/shared";
import { findShare } from "../access.js";
import { releaseCode, resolveCode } from "../codes.js";
import type { Ctx } from "../ctx.js";
import { ApiError, notFound } from "../errors.js";
import { type App, limited } from "./types.js";

export function codeRoutes(app: App, ctx: Ctx): void {
  app.get(
    "/api/codes/:code",
    {
      // Six digits are guessable; the limit keeps scanning the code space slow.
      preHandler: limited(ctx, "code", ctx.config.rateLimit.codePerMinute),
      schema: { params: codeParamsSchema, response: { 200: codeResolveResponseSchema } },
    },
    async (request) => {
      const { code } = request.params;
      const target = await resolveCode(ctx, code);
      if (!target) throw notFound("No share or lab with this code");
      if ("labId" in target) {
        const lab = await ctx.stores.labs.get(target.labId);
        if (!lab || lab.expiresAt.getTime() <= Date.now()) {
          await releaseCode(ctx, "lab", code);
          throw notFound("No share or lab with this code");
        }
        return { labId: target.labId };
      }
      try {
        // Also rejects a code whose share expired but whose Valkey key has not lapsed yet.
        await findShare(ctx, target.shareId);
      } catch (error) {
        // Only a share that is really gone frees its code; a database hiccup must not.
        if (error instanceof ApiError && (error.code === "not_found" || error.code === "expired")) {
          await releaseCode(ctx, "share", code);
        }
        throw error;
      }
      return { id: target.shareId };
    },
  );
}
