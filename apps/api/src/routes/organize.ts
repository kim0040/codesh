import {
  builtinTemplates,
  hasLabels,
  listTemplatesResponseSchema,
  publicSettingsSchema,
  putLabelsBodySchema,
  putLabelsResponseSchema,
  shareParamsSchema,
} from "@codesh/shared";
import type { Ctx } from "../ctx.js";
import { notFound } from "../errors.js";
import type { App } from "./types.js";

/** Folders and tags of "my shares", code templates and the settings the intro page shows. */
export function organizeRoutes(app: App, ctx: Ctx): void {
  app.put(
    "/api/shares/:id/labels",
    {
      schema: {
        params: shareParamsSchema,
        body: putLabelsBodySchema,
        response: { 200: putLabelsResponseSchema },
      },
    },
    async (request) => {
      const { clientId } = request.session;
      const { id } = request.params;
      // Labels are private to the person and only exist for shares in their list. Everything else,
      // including an expired share and one somebody else owns, looks like a share that is not there.
      const share = await ctx.stores.shares.get(id);
      const mine = share && (share.ownerId === clientId || share.savedBy.includes(clientId));
      if (!share || !mine || (share.expiresAt && share.expiresAt.getTime() <= Date.now())) {
        throw notFound("Share not found");
      }
      const labels = request.body;
      if (!hasLabels(labels)) {
        await ctx.stores.labels.delete(clientId, id);
        return labels;
      }
      const stored = await ctx.stores.labels.set(clientId, id, labels, new Date());
      return { folder: stored.folder, tags: stored.tags };
    },
  );

  app.get(
    "/api/templates",
    { schema: { response: { 200: listTemplatesResponseSchema } } },
    async () => {
      const { templates } = await ctx.settings();
      return [
        ...builtinTemplates(),
        ...templates.map((template) => ({ ...template, builtin: false })),
      ];
    },
  );

  app.get(
    "/api/settings/public",
    { schema: { response: { 200: publicSettingsSchema } } },
    async () => {
      const { contact, anonymousTtlHours, historyRetentionDays, maxUploadMB, guestAllowed } =
        await ctx.settings();
      return { contact, anonymousTtlHours, historyRetentionDays, maxUploadMB, guestAllowed };
    },
  );
}
