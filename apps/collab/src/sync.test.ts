import { defaultSettings, keys } from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness, servicesAvailable, sleep, storedText, waitFor } from "./testing/harness.js";

const available = await servicesAvailable();

const contains = (chunks: Uint8Array[], needle: string) =>
  Buffer.concat(chunks).includes(Buffer.from(needle, "utf8"));

describe.runIf(available)("collab sync and persistence", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness?.close());

  it("persists edits within a flush interval and compacts when the doc unloads", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const writer = await harness.connect(server.webSocketURL, share.id);
    await writer.synced;
    writer.text.insert(0, "hello persistence");
    await waitFor(
      async () => (await harness.stores.updates.lastSeq(share.id)) > 0,
      "first flush",
      1000,
    );
    expect(await storedText(harness.stores, share.id)).toBe("hello persistence");

    writer.destroy();
    await waitFor(() => !server.collab.docs.has(share.id), "unload after the idle delay");
    expect(await harness.stores.updates.read(share.id, 0)).toEqual([]);
    expect(await harness.stores.snapshots.latest(share.id, "compact")).not.toBeNull();
    expect((await harness.stores.snapshots.list(share.id, "history")).length).toBe(1);
    expect(await harness.redis.exists(keys.docLock(share.id))).toBe(0);

    const reader = await harness.connect(server.webSocketURL, share.id);
    await reader.synced;
    expect(reader.text.toString()).toBe("hello persistence");
  });

  it("keeps the doc in memory until the idle delay passes", async () => {
    const server = await harness.startServer({ timings: { unloadDelayMs: 1500 } });
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    client.destroy();
    await sleep(800);
    expect(server.collab.docs.has(share.id)).toBe(true);
    await waitFor(() => !server.collab.docs.has(share.id), "delayed unload", 3000);
  });

  it("never sends deleted text to a joining client, live or after a reload", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const secret = "SECRET-TOKEN-4f9a";
    const author = await harness.connect(server.webSocketURL, share.id);
    await author.synced;
    author.text.insert(0, `before ${secret} after`);
    await sleep(50);
    author.text.delete("before ".length, secret.length + 1);
    await waitFor(() => server.collab.docs.get(share.id)?.core.pendingUpdates === 0, "flush");

    const live = await harness.connect(server.webSocketURL, share.id);
    await live.synced;
    expect(live.text.toString()).toBe("before after");
    expect(contains(live.received, "before")).toBe(true);
    expect(contains(live.received, secret)).toBe(false);

    author.destroy();
    live.destroy();
    await waitFor(() => !server.collab.docs.has(share.id), "unload");
    const reloaded = await harness.connect(server.webSocketURL, share.id);
    await reloaded.synced;
    expect(reloaded.text.toString()).toBe("before after");
    expect(contains(reloaded.received, secret)).toBe(false);
  });

  it("converges clients on two instances that share Valkey", async () => {
    const first = await harness.startServer({ instanceId: "instance-a" });
    const second = await harness.startServer({ instanceId: "instance-b" });
    const share = await harness.createShare();
    const a = await harness.connect(first.webSocketURL, share.id);
    const b = await harness.connect(second.webSocketURL, share.id);
    await Promise.all([a.synced, b.synced]);

    const words: string[] = [];
    for (let i = 0; i < 40; i++) {
      const [client, tag] = i % 2 === 0 ? [a, "a"] : [b, "b"];
      const word = `${tag}${i};`;
      words.push(word);
      // Both prepend: concurrent inserts at the same position, without splitting a word.
      client.text.insert(0, word);
      if (i % 5 === 0) await sleep(5);
    }
    await waitFor(
      () =>
        a.text.toString() === b.text.toString() &&
        words.every((w) => a.text.toString().includes(w)),
      "both instances converge",
    );
    // Exactly one instance writes; the stored state converges as well.
    const owners = [first, second].filter((s) => s.collab.docs.get(share.id)?.core.owner);
    expect(owners).toHaveLength(1);
    await waitFor(
      async () => (await storedText(harness.stores, share.id)) === a.text.toString(),
      "stored state matches",
    );

    // The writer leaves; the other instance takes over and keeps persisting.
    const [owner] = owners;
    const survivor = owner === first ? b : a;
    (owner === first ? a : b).destroy();
    await waitFor(() => !owner?.collab.docs.has(share.id), "owner unloads");
    survivor.text.insert(0, "after-handover;");
    await waitFor(
      async () => (await storedText(harness.stores, share.id)).startsWith("after-handover;"),
      "survivor persists",
    );
  });

  it("refuses updates that would grow the doc past maxDocBytes and tells the client", async () => {
    await harness.stores.settings.put({ ...defaultSettings(), maxDocBytes: 4000 });
    try {
      const server = await harness.startServer();
      const share = await harness.createShare();
      const writer = await harness.connect(server.webSocketURL, share.id);
      const watcher = await harness.connect(server.webSocketURL, share.id);
      await Promise.all([writer.synced, watcher.synced]);
      writer.text.insert(0, "small;");
      await waitFor(() => watcher.text.toString() === "small;", "small edit accepted");

      writer.text.insert(writer.text.length, "x".repeat(5000));
      await waitFor(
        () => writer.stateless.some((m) => (m as { type: string }).type === "too_large"),
        "too_large notice",
      );
      expect(writer.stateless).toContainEqual({ type: "too_large", maxDocBytes: 4000 });
      await sleep(200);
      expect(watcher.text.toString()).toBe("small;");
      expect(await storedText(harness.stores, share.id)).toBe("small;");

      // Deleting is always allowed, and the writer is not left read-only.
      watcher.text.insert(0, "more;");
      await waitFor(() => watcher.text.toString() === "more;small;", "later edits still apply");
    } finally {
      await harness.stores.settings.put(defaultSettings());
    }
  });

  it("publishes a nearby preview and records activity", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare({ title: "Nearby demo", lastActiveAt: new Date(0) });
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    client.text.insert(0, lines.join("\n"));
    const key = keys.nearbyItem(share.id);
    await waitFor(async () => (await harness.redis.exists(key)) === 1, "nearby item");
    const item = await harness.redis.hgetall(key);
    expect(item).toMatchObject({ id: share.id, title: "Nearby demo", language: "typescript" });
    expect(item.preview).toBe(lines.slice(0, 8).join("\n"));
    expect(Number(item.participants)).toBeGreaterThanOrEqual(0);
    const ttl = await harness.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await waitFor(
      async () => ((await harness.stores.shares.get(share.id))?.lastActiveAt.getTime() ?? 0) > 0,
      "lastActiveAt written",
    );
    const stored = await harness.stores.shares.get(share.id);
    expect(stored?.sizeBytes).toBeGreaterThan(0);
    expect(stored?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it("reports flush latency in /metrics", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    for (let i = 0; i < 150; i++) {
      client.text.insert(client.text.length, `${i},`);
      await sleep(15);
    }
    await waitFor(() => server.collab.docs.get(share.id)?.core.pendingUpdates === 0, "flushed");
    const metric = await server.metrics.flushSeconds.get();
    const count = metric.values.find((v) => v.metricName === "codesh_collab_flush_seconds_count");
    const sum = metric.values.find((v) => v.metricName === "codesh_collab_flush_seconds_sum");
    expect(count?.value).toBeGreaterThan(0);
    const avgMs = ((sum?.value ?? 0) / (count?.value ?? 1)) * 1000;
    const le5 = metric.values.find((v) => v.labels.le === 0.005)?.value ?? 0;
    console.log(
      `[measure] flush latency: ${count?.value} writes, avg ${avgMs.toFixed(2)} ms, ${(
        (le5 / (count?.value ?? 1)) * 100
      ).toFixed(0)}% <= 5 ms`,
    );
    const body = await (await fetch(`${server.httpURL}/metrics`)).text();
    expect(body).toMatch(/codesh_collab_connections \d+/);
    expect(body).toMatch(/codesh_collab_updates_total\{origin="connection"\} \d+/);
  });
});
