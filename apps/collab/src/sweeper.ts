import { keys } from "@codesh/shared";
import type { Stores } from "@codesh/storage";
import type { ValkeyLock } from "./lock.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ids per `existing` query, far below MongoDB's 16 MiB limit for one `$in`. */
const EXISTING_BATCH = 10_000;

export interface SweepResult {
  orphans: number;
}

/**
 * §5 sweeper: removes update logs, snapshots, uploads and labels of shares that no longer exist, labels of
 * people who neither own nor have saved their share (a label write that raced with unsave or ban), history
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
      ...(await stores.labels.shareIds()),
    ]);
    const ids = [...referenced];
    const orphans: string[] = [];
    for (let i = 0; i < ids.length; i += EXISTING_BATCH) {
      const batch = ids.slice(i, i + EXISTING_BATCH);
      const alive = await stores.shares.existing(batch);
      orphans.push(...batch.filter((id) => !alive.has(id)));
      // A long run must not let another instance start a second sweep.
      await lock.renew(keys.sweeperLock);
    }
    for (const id of orphans) {
      await stores.updates.deleteForShare(id);
      await stores.snapshots.deleteForShare(id);
      await stores.files.deleteForShare(id);
      await stores.labels.deleteForShare(id);
    }
    // Labels are read before the shares, so a share saved in between keeps the label written after it.
    for (const clientId of await stores.labels.clientIds()) {
      const entries = await stores.labels.listForClient(clientId);
      const mine = new Set((await stores.shares.listForClient(clientId)).map((share) => share.id));
      for (const entry of entries) {
        if (!mine.has(entry.shareId)) await stores.labels.delete(clientId, entry.shareId);
      }
      await lock.renew(keys.sweeperLock);
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
