import type { Redis } from "ioredis";

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Ownership locks in Valkey (`SET NX PX` + renew, §7). The value is the instance id, so a process
 * restarted with the same id takes its own locks back at once instead of waiting for them to expire.
 */
export class ValkeyLock {
  constructor(
    private readonly redis: Redis,
    readonly owner: string,
    readonly ttlMs: number,
  ) {}

  async acquire(key: string): Promise<boolean> {
    if ((await this.redis.set(key, this.owner, "PX", this.ttlMs, "NX")) === "OK") return true;
    return this.renew(key);
  }

  async renew(key: string): Promise<boolean> {
    return (await this.redis.eval(RENEW, 1, key, this.owner, this.ttlMs)) === 1;
  }

  async release(key: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE, 1, key, this.owner)) === 1;
  }

  /** `renew` for many keys in one round trip; null where that key's command failed. */
  async renewMany(keys: string[]): Promise<Array<boolean | null>> {
    if (keys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.eval(RENEW, 1, key, this.owner, this.ttlMs);
    const results = (await pipeline.exec()) ?? [];
    return keys.map((_, i) => {
      const [error, value] = results[i] ?? [new Error("no reply")];
      return error ? null : value === 1;
    });
  }

  /** `acquire` for many keys in at most two round trips; null where that key's command failed. */
  async acquireMany(keys: string[]): Promise<Array<boolean | null>> {
    if (keys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.set(key, this.owner, "PX", this.ttlMs, "NX");
    const results = (await pipeline.exec()) ?? [];
    const acquired: Array<boolean | null> = keys.map((_, i) => {
      const [error, value] = results[i] ?? [new Error("no reply")];
      return error ? null : value === "OK";
    });
    const held = keys.flatMap((key, i) => (acquired[i] === false ? [{ key, i }] : []));
    const renewed = await this.renewMany(held.map((h) => h.key));
    held.forEach((h, j) => {
      acquired[h.i] = renewed[j] ?? null;
    });
    return acquired;
  }
}
