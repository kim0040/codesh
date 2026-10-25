import { apiKeys } from "@gachipad/shared";
import type { Ctx } from "./ctx.js";
import { ApiError } from "./errors.js";
import { abuseKeys } from "./net.js";

/** Reserve before writing. Failed requests consume their admission; clearing cookies cannot reset IP limits. */
export async function chargeQuota(
  ctx: Ctx,
  clientId: string,
  ip: string | undefined,
  kind: "shares" | "uploads" | "bytes",
  amount = 1,
): Promise<void> {
  if (amount === 0) return;
  await requireCapacity(ctx);
  const limits = ctx.config.limits;
  const clientLimit =
    kind === "shares"
      ? limits.QUOTA_SHARES_PER_CLIENT
      : kind === "uploads"
        ? limits.QUOTA_UPLOADS_PER_CLIENT
        : limits.QUOTA_BYTES_PER_CLIENT;
  const ipLimit =
    kind === "shares"
      ? limits.QUOTA_SHARES_PER_IP
      : kind === "uploads"
        ? limits.QUOTA_UPLOADS_PER_IP
        : limits.QUOTA_BYTES_PER_IP;
  const ipKeys = ip ? abuseKeys(ip) : [{ key: `client:${clientId}`, factor: 1 }];
  const result = await ctx.valkey.eval(
    RESERVE,
    1 + ipKeys.length,
    apiKeys.quota(kind, "c", clientId),
    ...ipKeys.map(({ key }) => apiKeys.quota(kind, "i", key)),
    amount,
    limits.QUOTA_WINDOW_SECONDS,
    clientLimit,
    ...ipKeys.map(({ factor }) => ipLimit * factor),
  );
  if (Number(result) === 0)
    throw new ApiError("rate_limited", "Storage quota reached; try again after the quota window", {
      "Retry-After": String(limits.QUOTA_WINDOW_SECONDS),
    });
}

/** KEYS: counters; ARGV: [amount, window seconds, limit of each key]. */
const RESERVE = `
local amount = tonumber(ARGV[1])
for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') + amount > tonumber(ARGV[i + 2]) then return 0 end
end
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], amount)
  redis.call('EXPIRE', KEYS[i], ARGV[2], 'NX')
end
return 1
`;

/** No eviction of codes, locks or grants. Stop optional/new writes before the protected store fills. */
export async function requireCapacity(ctx: Ctx): Promise<void> {
  if (Date.now() - ctx.capacityAt > 1000) {
    const info = await ctx.valkey.info("memory");
    const used = Number(/^used_memory:(\d+)/m.exec(info)?.[1] ?? 0);
    const max = Number(/^maxmemory:(\d+)/m.exec(info)?.[1] ?? 0);
    ctx.capacityAvailable = max === 0 || used < max * 0.9;
    ctx.capacityAt = Date.now();
  }
  if (!ctx.capacityAvailable)
    throw new ApiError("unavailable", "Server memory capacity reached; contact the operator", {
      "Retry-After": "30",
    });
}

export async function* chargeUpload(
  ctx: Ctx,
  clientId: string,
  ip: string,
  source: AsyncIterable<Uint8Array>,
) {
  for await (const chunk of source) {
    await chargeQuota(ctx, clientId, ip, "bytes", chunk.byteLength);
    yield chunk;
  }
}
