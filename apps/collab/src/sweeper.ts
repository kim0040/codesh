import { keys } from "@codesh/shared";
import type { Stores } from "@codesh/storage";
import type { ValkeyLock } from "./lock.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  orphans: number;
}

/**
 * §5 sweeper: removes update logs, snapshots and uploads of shares that no longer exist, history
 * snapshots past `historyRetentionDays`, expired uploads and audit entries past retention. One
 * instance at a time, guarded by `lock:sweeper`.
 */
export async function sweep(
  stores: Stores,
  lock: ValkeyLock,
  now = new Date(),
): Promise<SweepResult | null> {
  if (!(await lock.acquire(keys.sweeperLock))) return null;
  try {
    const settings = await stores.settings.get();
    const referenced = new Set([
      ...(await stores.updates.shareIds()),
      ...(await stores.snapshots.shareIds()),
      ...(await stores.files.shareIds()),
    ]);
    const alive = await stores.shares.existing([...referenced]);
    const orphans = [...referenced].filter((id) => !alive.has(id));
    for (const id of orphans) {
      await stores.updates.deleteForShare(id);
      await stores.snapshots.deleteForShare(id);
      await stores.files.deleteForShare(id);
    }
    await stores.snapshots.deleteOlderThan(
      "history",
      new Date(now.getTime() - settings.historyRetentionDays * DAY_MS),
    );
    await stores.files.deleteExpired(now);
    await stores.audit.deleteOlderThan(
      new Date(now.getTime() - settings.audit.retentionDays * DAY_MS),
    );
    return { orphans: orphans.length };
  } finally {
    await lock.release(keys.sweeperLock);
  }
}
