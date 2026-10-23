import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import Fastify, { type FastifyRequest } from "fastify";
import type { Ctx } from "../ctx.js";
import { rateLimit } from "../rate.js";

const instance = () => Fastify().withTypeProvider<ZodTypeProvider>();

/** The Fastify instance routes are registered on (zod type provider). */
export type App = ReturnType<typeof instance>;

/** `preHandler` that counts the request against a per-IP bucket (§7 `rl:<ip>:<bucket>`). */
export const limited =
  (ctx: Ctx, bucket: "code" | "create" | "login", limit: number) =>
  async (request: FastifyRequest): Promise<void> => {
    await rateLimit(ctx, request.session.ip, bucket, limit);
  };

export const OK = { ok: true as const };

/** Runs `fn` over `items` with at most `size` calls in flight, keeping the order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}
