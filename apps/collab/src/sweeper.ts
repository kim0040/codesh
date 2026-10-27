import { keys } from "@gachipad/shared";
import { type Stores, sqlErrorCode } from "@gachipad/storage";
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
    if (stores.maintenance) {
      return await stores.maintenance.sweep(now, async () => {
        if (!(await lock.renew(keys.sweeperLock))) throw new Error("sweeper lock lost");
      });
    }
    const stage = async <T>(category: string, work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        console.error(`collab: ${category} cleanup failed`, sqlErrorCode(error) ?? "UNKNOWN");
        return undefined;
      }
    };
    const renew = async () => {
      if (!(await lock.renew(keys.sweeperLock))) throw new Error("sweeper lock lost");
    };
    const settings = await stage("settings", () => stores.settings.get());
    // Explicit expiry also gives SQL backends the same cleanup as MongoDB's TTL indexes.
    await stage("shares expiry", () => stores.shares.deleteExpired(now));
    await stage("labs expiry", () => stores.labs.deleteExpired(now));
    await renew();
    const referenced = new Set<string>();
    for (const [category, store] of [
      ["updates", stores.updates],
      ["snapshots", stores.snapshots],
      ["files", stores.files],
      ["labels", stores.labels],
    ] as const) {
      const found = await stage(`${category} references`, () => store.shareIds());
      for (const id of found ?? []) referenced.add(id);
    }
    const ids = [...referenced];
    const orphans: string[] = [];
    for (let i = 0; i < ids.length; i += EXISTING_BATCH) {
      const batch = ids.slice(i, i + EXISTING_BATCH);
      const alive = await stage("share existence", () => stores.shares.existing(batch));
      // A failed existence read must never classify live content as orphaned.
      if (alive) orphans.push(...batch.filter((id) => !alive.has(id)));
      await renew();
    }
    for (const id of orphans) {
      await stage("orphan updates", () => stores.updates.deleteForShare(id));
      await stage("orphan snapshots", () => stores.snapshots.deleteForShare(id));
      await stage("orphan files", () => stores.files.deleteForShare(id));
      await stage("orphan labels", () => stores.labels.deleteForShare(id));
      await renew();
    }
    // Labels are read before the shares, so a share saved in between keeps the label written after it.
    if (stores.labels.deleteInaccessible) {
      await stage("inaccessible labels", async () => stores.labels.deleteInaccessible?.());
      await renew();
    } else {
      const clients = await stage("label clients", () => stores.labels.clientIds());
      for (const clientId of clients ?? []) {
        await stage("client labels", async () => {
          const entries = await stores.labels.listForClient(clientId);
          const mine = new Set(
            (await stores.shares.listForClient(clientId)).map((share) => share.id),
          );
          for (const entry of entries) {
            if (!mine.has(entry.shareId)) await stores.labels.delete(clientId, entry.shareId);
          }
        });
        await renew();
      }
    }
    if (settings)
      await stage("history", () =>
        stores.snapshots.deleteOlderThan(
          "history",
          new Date(now.getTime() - settings.historyRetentionDays * DAY_MS),
        ),
      );
    await renew();
    await stage("uploads expiry", () => stores.files.deleteExpired(now));
    await renew();
    if (settings)
      await stage("audit", () =>
        stores.audit.deleteOlderThan(
          new Date(now.getTime() - settings.audit.retentionDays * DAY_MS),
        ),
      );
    return { orphans: orphans.length };
  } finally {
    await lock.release(keys.sweeperLock);
  }
}
