import {
  apiKeys,
  keys,
  kickBodySchema,
  listPendingResponseSchema,
  okResponseSchema,
  pendingParamsSchema,
  resolvePendingBodySchema,
  shareParamsSchema,
} from "@codesh/shared";
import { findShare, requireOwner } from "../access.js";
import { randomKey } from "../crypto.js";
import type { Ctx } from "../ctx.js";
import { invalid, notFound } from "../errors.js";
import { syncExpiry } from "../shares.js";
import { type App, OK } from "./types.js";

/** Owner tools: removing people and answering join requests. */
export function moderationRoutes(app: App, ctx: Ctx): void {
  app.post(
    "/api/shares/:id/kick",
    {
      schema: {
        params: shareParamsSchema,
        body: kickBodySchema,
        response: { 200: okResponseSchema },
      },
    },
    async (request) => {
      const { clientId, ban } = request.body;
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      if (clientId === share.ownerId) throw invalid("The owner cannot be removed");

      // Persist before publishing: old tokens stay revoked after reconnects and Valkey restarts.
      await ctx.stores.shares.update(share.id, { access: { generation: randomKey() } });
      // Without the grant the client has to pass PIN and approval again to come back.
      await ctx.valkey.hdel(apiKeys.grants(share.id), clientId);
      await ctx.valkey.hdel(keys.pending(share.id), clientId);
      if (ban) {
        // The address is banned too, so a fresh cookie does not get back in, unless someone else
        // joined from it: behind NAT or a proxy that hides addresses it would ban a whole class.
        const admitted = await ctx.valkey.hgetall(apiKeys.admittedNetworks(share.id));
        const address = admitted[clientId];
        const shared = Object.entries(admitted).some(
          ([other, value]) => other !== clientId && other !== share.ownerId && value === address,
        );
        if (address && !shared) await ctx.valkey.sadd(apiKeys.bannedNetworks(share.id), address);
        await ctx.stores.shares.addBan(share.id, clientId);
        // A banned client could neither unsave the share nor would its entry ever let the share expire.
        const settings = await ctx.settings();
        const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
        const unsaved = await ctx.stores.shares.removeSaved(share.id, clientId, expiresAt);
        if (unsaved) await syncExpiry(ctx, unsaved);
        await ctx.stores.labels.delete(clientId, share.id);
      }
      await ctx.publishPerm(share.id, "kick", clientId);
      await ctx.publishUser(clientId, {
        event: "kicked",
        data: { shareId: share.id, banned: ban },
      });
      await ctx.audit(request, ban ? "share.ban" : "share.kick", share.id, { clientId });
      return OK;
    },
  );

  app.get(
    "/api/shares/:id/pending",
    { schema: { params: shareParamsSchema, response: { 200: listPendingResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      const pending = await ctx.valkey.hgetall(keys.pending(share.id));
      return Object.entries(pending).map(([clientId, name]) => ({ clientId, name }));
    },
  );

  app.post(
    "/api/shares/:id/pending/:clientId",
    {
      schema: {
        params: pendingParamsSchema,
        body: resolvePendingBodySchema,
        response: { 200: okResponseSchema },
      },
    },
    async (request) => {
      const { clientId } = request.params;
      const { approve } = request.body;
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      const waiting = await ctx.valkey.hdel(keys.pending(share.id), clientId);
      if (waiting === 0) throw notFound("No such join request");
      if (approve) {
        // HSETNX keeps an edit key the client may have presented earlier.
        await ctx.valkey.hsetnx(apiKeys.grants(share.id), clientId, "");
      }
      await ctx.publishUser(clientId, {
        event: "approval-result",
        data: { shareId: share.id, approved: approve },
      });
      await ctx.audit(request, approve ? "share.approve" : "share.deny", share.id, { clientId });
      return OK;
    },
  );
}
