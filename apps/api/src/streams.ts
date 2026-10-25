import { randomUUID } from "node:crypto";
import { apiKeys } from "@gachipad/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { abuseKeys } from "./net.js";
import { requireCapacity } from "./quotas.js";
import type { Session } from "./session.js";

const LEASE_MS = 90_000;
/** Distributed leases cap concurrent streams, including sockets whose subscriptions are still opening. */
export async function reserveStream(ctx: Ctx, session: Session) {
  await requireCapacity(ctx);
  const id = randomUUID();
  const { SSE_MAX_PER_CLIENT, SSE_MAX_PER_IP } = ctx.config.limits;
  const ipKeys = abuseKeys(session.ip);
  const leases = [
    apiKeys.streams("c", session.clientId),
    ...ipKeys.map(({ key }) => apiKeys.streams("i", key)),
  ];
  const renew = async () => {
    const result = await ctx.valkey.eval(
      RESERVE,
      leases.length,
      ...leases,
      Date.now(),
      LEASE_MS,
      id,
      SSE_MAX_PER_CLIENT,
      ...ipKeys.map(({ factor }) => SSE_MAX_PER_IP * factor),
    );
    if (Number(result) !== 1)
      throw new ApiError("rate_limited", "Too many event streams", { "Retry-After": "30" });
  };
  await renew();
  return {
    renew: () => renew(),
    async release() {
      const multi = ctx.valkey.multi();
      for (const lease of leases) multi.zrem(lease, id);
      await multi.exec();
    },
  };
}
/** KEYS: lease sets; ARGV: [now, lease ms, stream id, limit of each set]. */
const RESERVE = `
local now = tonumber(ARGV[1])
for i = 1, #KEYS do
 redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
 local exists = redis.call('ZSCORE', KEYS[i], ARGV[3])
 if not exists and redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i+3]) then return 0 end
end
for i = 1, #KEYS do
 redis.call('ZADD', KEYS[i], now + tonumber(ARGV[2]), ARGV[3])
 redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return 1
`;
