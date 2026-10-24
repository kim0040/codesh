import { randomUUID } from "node:crypto";
import { apiKeys } from "@codesh/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { networkKey } from "./net.js";
import { requireCapacity } from "./quotas.js";
import type { Session } from "./session.js";

const LEASE_MS = 90_000;
/** Distributed leases cap concurrent streams, including sockets whose subscriptions are still opening. */
export async function reserveStream(ctx: Ctx, session: Session) {
  await requireCapacity(ctx);
  const id = randomUUID();
  const client = apiKeys.streams("c", session.clientId);
  const ip = apiKeys.streams("i", networkKey(session.ip));
  const renew = async () => {
    const result = await ctx.valkey.eval(
      RESERVE,
      2,
      client,
      ip,
      Date.now(),
      LEASE_MS,
      id,
      ctx.config.limits.SSE_MAX_PER_CLIENT,
      ctx.config.limits.SSE_MAX_PER_IP,
    );
    if (Number(result) !== 1)
      throw new ApiError("rate_limited", "Too many event streams", { "Retry-After": "30" });
  };
  await renew();
  return {
    renew: () => renew(),
    async release() {
      await ctx.valkey.multi().zrem(client, id).zrem(ip, id).exec();
    },
  };
}
const RESERVE = `
local now = tonumber(ARGV[1])
for i = 1, 2 do
 redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
 local exists = redis.call('ZSCORE', KEYS[i], ARGV[3])
 if not exists and redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i+3]) then return 0 end
end
for i = 1, 2 do
 redis.call('ZADD', KEYS[i], now + tonumber(ARGV[2]), ARGV[3])
 redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return 1
`;
