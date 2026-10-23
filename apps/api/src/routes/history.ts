import {
  apiKeys,
  historyParamsSchema,
  listHistoryResponseSchema,
  okResponseSchema,
  restoreBodySchema,
  shareParamsSchema,
} from "@codesh/shared";
import * as Y from "yjs";
import { findShare, requireOwner } from "../access.js";
import type { Ctx } from "../ctx.js";
import { contentBytes, readContent, sendCommand } from "../docs.js";
import { notFound } from "../errors.js";
import { type App, OK } from "./types.js";

/** Edit history is kept server-side and only the owner may read it (never sent to participants). */
export function historyRoutes(app: App, ctx: Ctx): void {
  app.get(
    "/api/shares/:id/history",
    { schema: { params: shareParamsSchema, response: { 200: listHistoryResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      const entries = await ctx.stores.snapshots.list(share.id, "history");
      return entries.map((entry) => ({ seq: entry.seq, at: entry.at.toISOString() }));
    },
  );

  app.get(
    "/api/shares/:id/history/:seq",
    { schema: { params: historyParamsSchema } },
    async (request, reply) => {
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      const snapshot = await ctx.stores.snapshots.get(share.id, "history", request.params.seq);
      if (!snapshot) throw notFound("No such history entry");
      return reply
        .header("Content-Type", "application/octet-stream")
        .send(Buffer.from(snapshot.state));
    },
  );

  app.post(
    "/api/shares/:id/restore",
    {
      schema: {
        params: shareParamsSchema,
        body: restoreBodySchema,
        response: { 200: okResponseSchema },
      },
    },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      const snapshot = await ctx.stores.snapshots.get(share.id, "history", request.body.seq);
      if (!snapshot) throw notFound("No such history entry");

      // CRDT state only grows, so "going back" is a new edit that collab writes (§6.11).
      await sendCommand(ctx, share.id, { kind: "restore", seq: request.body.seq });
      const past = new Y.Doc();
      Y.applyUpdate(past, snapshot.state);
      const target = readContent(past);
      await ctx.stores.shares.update(share.id, {
        title: target.title,
        language: target.language,
        updatedAt: new Date(),
        sizeBytes: contentBytes(target),
      });
      await ctx.valkey.del(apiKeys.preview(share.id));
      await ctx.audit(request, "share.restore", share.id, { seq: request.body.seq });
      return OK;
    },
  );
}
