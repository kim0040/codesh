import {
  keys,
  patchSessionBodySchema,
  type SessionResponse,
  sessionResponseSchema,
} from "@codesh/shared";
import type { Ctx } from "../ctx.js";
import { publishPresence } from "../presence.js";
import { type Session, saveProfile } from "../session.js";
import type { App } from "./types.js";

export function sessionView(session: Session): SessionResponse {
  return {
    clientId: session.clientId,
    name: session.name,
    color: session.color,
    net: session.net,
    room: session.room,
    identity: session.identity
      ? {
          provider: session.identity.provider,
          ...(session.identity.name ? { name: session.identity.name } : {}),
          ...(session.identity.email ? { email: session.identity.email } : {}),
        }
      : null,
  };
}

export function sessionRoutes(app: App, ctx: Ctx): void {
  app.get(
    "/api/session",
    { schema: { response: { 200: sessionResponseSchema } } },
    async (request) => sessionView(request.session),
  );

  app.patch(
    "/api/session",
    { schema: { body: patchSessionBodySchema, response: { 200: sessionResponseSchema } } },
    async (request) => {
      const { session, body } = request;
      await saveProfile(ctx, session.clientId, body);
      const updated: Session = {
        ...session,
        name: body.name ?? session.name,
        color: body.color ?? session.color,
      };
      // Someone online sees the new name at once; offline users have no card to update.
      if (await ctx.valkey.exists(keys.presenceUser(session.clientId))) {
        await publishPresence(ctx, session.net);
      }
      return sessionView(updated);
    },
  );
}
