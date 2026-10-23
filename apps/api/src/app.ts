import { type ErrorCode, errorResponse } from "@codesh/shared";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import Fastify, { type FastifyServerOptions } from "fastify";
import { Ctx, type Deps } from "./ctx.js";
import { ApiError, forbidden } from "./errors.js";
import { rateLimit } from "./rate.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { codeRoutes } from "./routes/codes.js";
import { eventRoutes } from "./routes/events.js";
import { historyRoutes } from "./routes/history.js";
import { labRoutes } from "./routes/labs.js";
import { moderationRoutes } from "./routes/moderation.js";
import { sessionRoutes } from "./routes/session.js";
import { shareRoutes } from "./routes/shares.js";
import { socialRoutes } from "./routes/social.js";
import { systemRoutes } from "./routes/system.js";
import { transferRoutes } from "./routes/transfer.js";
import { SECURITY_HEADERS } from "./security.js";
import { clientIp, loadSession } from "./session.js";

/** Paths a visitor without a login may use even when `settings.guestAllowed` is false. */
const OPEN_WITHOUT_LOGIN = ["/api/session", "/api/auth/", "/api/admin/"];

/** Hard ceiling for one multipart request; the real limit is `settings.maxUploadMB` per request. */
const MULTIPART_CEILING_BYTES = 4 * 1024 * 1024 * 1024;

function statusOf(error: { statusCode?: number }): number {
  return typeof error.statusCode === "number" ? error.statusCode : 500;
}

export function buildApp(deps: Deps, options: FastifyServerOptions = {}) {
  const ctx = new Ctx(deps);
  // Fastify's own `trustProxy` stays off: net.ts applies the TRUST_PROXY rules of §7 itself.
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cookie, { secret: ctx.config.sessionSecret });
  app.register(multipart, {
    // Folder uploads send relative paths as file names; routes sanitise them.
    preservePath: true,
    limits: { fileSize: MULTIPART_CEILING_BYTES, files: 1000, parts: 1200, fields: 50 },
  });
  app.decorateRequest("session");

  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (!request.url.startsWith("/api/")) return;
    await rateLimit(ctx, clientIp(ctx, request), "api", ctx.config.rateLimit.apiPerMinute);
    request.session = await loadSession(ctx, request, reply);
    const settings = await ctx.settings();
    if (
      !settings.guestAllowed &&
      !request.session.identity &&
      !OPEN_WITHOUT_LOGIN.some((prefix) => request.url.startsWith(prefix))
    ) {
      throw forbidden("Sign in to use this server");
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    ctx.metrics.requests.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  // Open SSE streams never end by themselves and would keep `app.close()` waiting.
  app.addHook("preClose", async () => {
    for (const close of [...ctx.streamClosers]) close();
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorResponse("not_found", "Not found")),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.status)
        .headers(error.headers)
        .send(errorResponse(error.code, error.message));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(errorResponse("validation", error.message));
    }
    const failure = error as { code?: string; message: string; statusCode?: number };
    const status = statusOf(failure);
    let code: ErrorCode | null = null;
    if (
      status === 413 ||
      failure.code === "FST_REQ_FILE_TOO_LARGE" ||
      failure.code === "FST_FILES_LIMIT" ||
      failure.code === "FST_PARTS_LIMIT"
    ) {
      code = "too_large";
    } else if (status >= 400 && status < 500) {
      code = "validation";
    }
    if (code) {
      return reply
        .code(code === "too_large" ? 413 : 400)
        .send(errorResponse(code, failure.message));
    }
    // The contract has no code for unexpected failures; do not leak details to the client.
    request.log.error({ err: error }, "unhandled error");
    return reply
      .code(500)
      .send({ statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" });
  });

  systemRoutes(app, ctx);
  sessionRoutes(app, ctx);
  authRoutes(app, ctx);
  codeRoutes(app, ctx);
  shareRoutes(app, ctx);
  moderationRoutes(app, ctx);
  historyRoutes(app, ctx);
  socialRoutes(app, ctx);
  transferRoutes(app, ctx);
  labRoutes(app, ctx);
  eventRoutes(app, ctx);
  adminRoutes(app, ctx);

  return app;
}

export type App = ReturnType<typeof buildApp>;
