import {
  apiKeys,
  createInviteBodySchema,
  keys,
  nearbyResponseSchema,
  okResponseSchema,
  PRESENCE_USER_TTL_SECONDS,
  presenceResponseSchema,
} from "@codesh/shared";
import { findShare, requireParticipant } from "../access.js";
import type { Ctx } from "../ctx.js";
import { forbidden, invalid, notFound } from "../errors.js";
import { listNearby, listPresence } from "../presence.js";
import { userRef } from "../session.js";
import { getUploadMeta } from "../uploads.js";
import { type App, limited, OK } from "./types.js";

export function socialRoutes(app: App, ctx: Ctx): void {
  app.get(
    "/api/presence",
    { schema: { response: { 200: presenceResponseSchema } } },
    async (request) => {
      const { clientId, net } = request.session;
      return (await listPresence(ctx, net)).filter((user) => user.clientId !== clientId);
    },
  );

  app.get("/api/nearby", { schema: { response: { 200: nearbyResponseSchema } } }, async (request) =>
    listNearby(ctx, request.session.net),
  );

  app.post(
    "/api/invites",
    {
      preHandler: limited(ctx, "create", ctx.config.rateLimit.createPerMinute),
      schema: { body: createInviteBodySchema, response: { 200: okResponseSchema } },
    },
    async (request) => {
      const { session, body } = request;
      const share = await findShare(ctx, body.shareId);
      const access = await requireParticipant(ctx, share, session);
      const from = userRef(session);

      let upload: Awaited<ReturnType<typeof getUploadMeta>> = null;
      if (body.uploadId !== undefined) {
        upload = await getUploadMeta(ctx, body.uploadId);
        if (!upload) throw notFound("Upload not found");
        if (upload.ownerId !== session.clientId) throw forbidden("You did not upload this file");
      }
      const grantee = body.to === "net" ? `net:${session.net}` : body.to;

      if (body.to === "net") {
        // Putting a share on every screen is a presenter's tool.
        if (!access.owner) throw forbidden("Only the owner can show a share to the whole room");
      } else {
        if (body.to === session.clientId) throw invalid("You cannot invite yourself");
        const seen = await ctx.valkey.zscore(keys.presenceNet(session.net), body.to);
        if (seen === null || Number(seen) < Date.now() - PRESENCE_USER_TTL_SECONDS * 1000) {
          throw notFound("That user is not online on your network");
        }
      }

      if (upload && body.uploadId !== undefined) {
        const grants = apiKeys.uploadGrants(body.uploadId);
        await ctx.valkey.sadd(grants, grantee);
        await ctx.valkey.pexpireat(grants, upload.expiresAt);
      }

      if (body.to === "net") {
        await ctx.publishNet(session.net, {
          event: "broadcast",
          data: { from, shareId: share.id, title: share.title },
        });
      } else {
        await ctx.publishUser(body.to, {
          event: "invite",
          data: {
            from,
            shareId: share.id,
            title: share.title,
            language: share.language,
            ...(body.note ? { note: body.note } : {}),
            ...(body.uploadId ? { uploadId: body.uploadId } : {}),
          },
        });
      }
      await ctx.audit(request, "invite.send", share.id, { to: body.to });
      return OK;
    },
  );
}
