import { defaultSettings, generateClientId, keys } from "@codesh/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValkeyLock } from "./lock.js";
import { sweep } from "./sweeper.js";
import { Harness, servicesAvailable } from "./testing/harness.js";

const available = await servicesAvailable();
const DAY_MS = 24 * 3600_000;

describe.runIf(available)("sweeper", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness?.close());

  it("removes data of deleted shares, old history and expired uploads", async () => {
    const { stores } = harness;
    await stores.settings.put({ ...defaultSettings(), historyRetentionDays: 7 });
    const live = await harness.createShare();
    const now = new Date();
    const old = new Date(now.getTime() - 8 * DAY_MS);
    const bytes = new Uint8Array([1]);
    for (const shareId of [live.id, "gone0001"]) {
      await stores.updates.append(shareId, [{ seq: 1, data: bytes }], now);
      await stores.snapshots.put({ shareId, seq: 1, state: bytes, at: now, kind: "compact" });
    }
    await stores.snapshots.put({
      shareId: live.id,
      seq: 0,
      state: bytes,
      at: old,
      kind: "history",
    });
    await stores.snapshots.put({
      shareId: live.id,
      seq: 1,
      state: bytes,
      at: now,
      kind: "history",
    });
    const upload = {
      name: "a.txt",
      contentType: "text/plain",
      ownerId: generateClientId(),
      data: bytes,
    };
    await stores.files.put({
      ...upload,
      shareId: "gone0001",
      expiresAt: new Date(now.getTime() + DAY_MS),
    });
    await stores.files.put({ ...upload, expiresAt: old });
    const owner = generateClientId();
    const labels = { folder: "Week 1", tags: ["loops"] };
    await stores.labels.set(owner, live.id, labels, now);
    await stores.labels.set(owner, "gone0001", labels, now);
    await stores.labels.set(generateClientId(), "gone0001", labels, now);

    const lock = new ValkeyLock(harness.redis, "sweeper-test", 60_000);
    expect(await sweep(stores, lock, now)).toEqual({ orphans: 1 });

    expect(await stores.updates.shareIds()).toEqual([live.id]);
    expect(await stores.snapshots.shareIds()).toEqual([live.id]);
    expect((await stores.snapshots.list(live.id, "history")).map((h) => h.seq)).toEqual([1]);
    expect(await stores.files.shareIds()).toEqual([]);
    expect(await stores.labels.shareIds()).toEqual([live.id]);
    expect(await stores.labels.get(owner, live.id)).toMatchObject(labels);
    expect(await stores.files.deleteExpired(now)).toBe(0);
    expect(await harness.redis.exists(keys.sweeperLock)).toBe(0);
  });

  it("removes labels of a share that only has labels left", async () => {
    const { stores } = harness;
    const owner = generateClientId();
    await stores.labels.set(owner, "gone0002", { folder: null, tags: ["a"] }, new Date());
    const lock = new ValkeyLock(harness.redis, "sweeper-test", 60_000);
    expect(await sweep(stores, lock)).toEqual({ orphans: 1 });
    expect(await stores.labels.get(owner, "gone0002")).toBeNull();
  });

  it("runs on one instance at a time", async () => {
    const holder = new ValkeyLock(harness.redis, "other-instance", 60_000);
    expect(await holder.acquire(keys.sweeperLock)).toBe(true);
    try {
      const lock = new ValkeyLock(harness.redis, "sweeper-test", 60_000);
      expect(await sweep(harness.stores, lock)).toBeNull();
    } finally {
      await holder.release(keys.sweeperLock);
    }
  });
});
