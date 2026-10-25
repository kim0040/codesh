import { randomBytes } from "node:crypto";
import {
  apiKeys,
  authProvidersResponseSchema,
  LEGACY_SESSION_COOKIE,
  ldapLoginBodySchema,
  okResponseSchema,
  sessionResponseSchema,
} from "@gachipad/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ldapConfigSchema, oidcConfigSchema, type VerifiedIdentity } from "../auth/adapters.js";
import type { Ctx } from "../ctx.js";
import { forbidden, invalid, notFound } from "../errors.js";
import { issueSession, type Session, saveProfile } from "../session.js";
import { sessionView } from "./session.js";
import { type App, limited, OK } from "./types.js";

const OIDC_STATE_SECONDS = 600;
const IDENTITY_TTL_SECONDS = 30 * 24 * 3600;
const oidcCallbackQuery = z.object({ state: z.string().min(1).max(200) }).catchall(z.string());

/**
 * Optional login (§8). A verified identity is only bound to the existing `gachipad_sid` session, so
 * every other endpoint keeps working unchanged; `settings.guestAllowed = false` makes it mandatory.
 */
export function authRoutes(app: App, ctx: Ctx): void {
  const login = limited(ctx, "login", ctx.config.rateLimit.loginPerMinute);

  const oidcConfig = async () => {
    const raw = (await ctx.settings()).auth.oidc;
    if (raw === null || !ctx.oidc) throw notFound("OIDC login is not enabled");
    const parsed = oidcConfigSchema.safeParse(raw);
    if (!parsed.success) throw invalid("OIDC settings are invalid");
    return parsed.data;
  };

  const bind = async (clientId: string, identity: VerifiedIdentity) => {
    const key = apiKeys.identity(clientId);
    await ctx.valkey
      .multi()
      .del(key)
      .hset(key, {
        provider: identity.provider,
        subject: identity.subject,
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.email ? { email: identity.email } : {}),
      })
      .expire(key, IDENTITY_TTL_SECONDS)
      .exec();
  };

  /**
   * Logging in or out gives the browser a new `gachipad_sid`: the next person on a shared PC does
   * not inherit the previous user's shares, uploads and history, and a session id planted before
   * the login (cookie tossing from a sibling host) is worthless. The display name and color move
   * to the new session on login; shares owned by the old one stay with it.
   */
  const startSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    identity: VerifiedIdentity,
  ): Promise<Session> => {
    const previous = request.session;
    if (request.cookies[LEGACY_SESSION_COOKIE] !== undefined) {
      reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
    }
    const clientId = issueSession(ctx, reply);
    const profile = await ctx.valkey.hgetall(apiKeys.profile(previous.clientId));
    if (Object.keys(profile).length > 0) {
      await saveProfile(ctx, clientId, profile);
    }
    await ctx.valkey.del(apiKeys.identity(previous.clientId));
    await bind(clientId, identity);
    return { ...previous, clientId };
  };

  app.get(
    "/api/auth/providers",
    { schema: { response: { 200: authProvidersResponseSchema } } },
    async () => {
      const settings = await ctx.settings();
      return {
        oidc: settings.auth.oidc !== null && ctx.oidc !== undefined,
        ldap: settings.auth.ldap !== null && ctx.ldap !== undefined,
        guestAllowed: settings.guestAllowed,
      };
    },
  );

  app.get("/api/auth/oidc/login", { preHandler: login }, async (request, reply) => {
    const config = await oidcConfig();
    const redirectUri = config.redirectUri ?? `${ctx.config.publicUrl}/api/auth/oidc/callback`;
    if (!config.redirectUri && !ctx.config.publicUrl) throw invalid("PUBLIC_URL is not set");
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    await ctx.valkey.set(
      apiKeys.oidcState(state),
      JSON.stringify({ clientId: request.session.clientId, nonce, codeVerifier }),
      "EX",
      OIDC_STATE_SECONDS,
    );
    const url = await (ctx.oidc as NonNullable<Ctx["oidc"]>).authorizationUrl(config, {
      redirectUri,
      state,
      nonce,
      codeVerifier,
    });
    return reply.redirect(url.toString());
  });

  app.get(
    "/api/auth/oidc/callback",
    { preHandler: login, schema: { querystring: oidcCallbackQuery } },
    async (request, reply) => {
      const config = await oidcConfig();
      const redirectUri = config.redirectUri ?? `${ctx.config.publicUrl}/api/auth/oidc/callback`;
      // One use only: the state is consumed whether or not the exchange succeeds.
      const stored = await ctx.valkey.getdel(apiKeys.oidcState(request.query.state));
      if (!stored) throw forbidden("Login expired, start again");
      const pending = JSON.parse(stored) as {
        clientId: string;
        nonce: string;
        codeVerifier: string;
      };
      // The browser that started the login must be the one finishing it.
      if (pending.clientId !== request.session.clientId)
        throw forbidden("Login was started elsewhere");
      const currentUrl = new URL(redirectUri);
      currentUrl.search = new URL(request.url, "http://localhost").search;
      let identity: VerifiedIdentity;
      try {
        identity = await (ctx.oidc as NonNullable<Ctx["oidc"]>).exchange(config, {
          redirectUri,
          currentUrl,
          state: request.query.state,
          nonce: pending.nonce,
          codeVerifier: pending.codeVerifier,
        });
      } catch (error) {
        request.log.warn({ err: error }, "oidc exchange failed");
        throw forbidden("Login failed");
      }
      const session = await startSession(request, reply, identity);
      if (!session.name && identity.name) {
        await saveProfile(ctx, session.clientId, { name: identity.name.slice(0, 40) });
      }
      await ctx.audit(request, "auth.oidc", undefined, { subject: identity.subject });
      return reply.redirect(ctx.config.publicUrl ? `${ctx.config.publicUrl}/` : "/");
    },
  );

  app.post(
    "/api/auth/ldap/login",
    {
      preHandler: login,
      schema: { body: ldapLoginBodySchema, response: { 200: sessionResponseSchema } },
    },
    async (request, reply) => {
      const raw = (await ctx.settings()).auth.ldap;
      if (raw === null || !ctx.ldap) throw notFound("LDAP login is not enabled");
      const config = ldapConfigSchema.safeParse(raw);
      if (!config.success) throw invalid("LDAP settings are invalid");
      let identity: VerifiedIdentity | null;
      try {
        identity = await ctx.ldap.authenticate(
          config.data,
          request.body.username,
          request.body.password,
        );
      } catch (error) {
        request.log.warn({ err: error }, "ldap login failed");
        throw forbidden("The directory is not reachable");
      }
      if (!identity) throw forbidden("Wrong username or password");
      const session = await startSession(request, reply, identity);
      let name = session.name;
      if (!name && identity.name) {
        name = identity.name.slice(0, 40);
        await saveProfile(ctx, session.clientId, { name });
      }
      await ctx.audit(request, "auth.ldap", undefined, { subject: identity.subject });
      return sessionView({
        ...session,
        name,
        identity: {
          provider: identity.provider,
          subject: identity.subject,
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.email ? { email: identity.email } : {}),
        },
      });
    },
  );

  app.post(
    "/api/auth/logout",
    { schema: { response: { 200: okResponseSchema } } },
    async (request, reply) => {
      await ctx.valkey.del(apiKeys.identity(request.session.clientId));
      if (request.cookies[LEGACY_SESSION_COOKIE] !== undefined) {
        reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
      }
      issueSession(ctx, reply);
      return OK;
    },
  );
}
