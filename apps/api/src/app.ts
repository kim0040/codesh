import { errorResponse, healthResponseSchema } from "@codesh/shared";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import Fastify, { type FastifyServerOptions } from "fastify";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorResponse("not_found", "Not found")),
  );

  app.setErrorHandler((error, _request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send(errorResponse("validation", error.message));
    }
    // The contract has no code for unexpected failures; leave those to Fastify's default handler.
    return reply.send(error);
  });

  app.get("/healthz", { schema: { response: { 200: healthResponseSchema } } }, async () => ({
    ok: true as const,
  }));

  return app;
}

export type App = ReturnType<typeof buildApp>;
