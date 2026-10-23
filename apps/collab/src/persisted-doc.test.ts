import { generateShareId } from "@codesh/shared";
import { createTestDatabase, mongoAvailable, type TestDatabase } from "@codesh/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadPersisted, PersistedDoc } from "./persisted-doc.js";

const available = await mongoAvailable();

describe.runIf(available)("PersistedDoc", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("codesh_persist");
  });
  afterAll(() => database?.drop());

  function open(shareId = generateShareId(), options: { compactAfter?: number } = {}) {
    const doc = new Y.Doc();
    const core = new PersistedDoc(shareId, doc, database.stores, {
      compactAfter: options.compactAfter ?? 200,
      historyIntervalMs: 30_000,
    });
    return { shareId, doc, core, text: doc.getText("file:main") };
  }

  async function reload(shareId: string) {
    const doc = new Y.Doc();
    const loaded = await loadPersisted(database.stores, shareId);
    if (loaded.state) Y.applyUpdate(doc, loaded.state);
    return { text: doc.getText("file:main").toString(), loaded };
  }

  it("buffers updates synchronously and writes them as one entry per flush", async () => {
    const { shareId, core, text } = open();
    core.owner = true;
    await core.load();
    text.insert(0, "hello");
    text.insert(5, " world");
    expect(core.pendingUpdates).toBe(2);
    await core.flush();
    expect(core.pendingUpdates).toBe(0);
    expect(await database.stores.updates.lastSeq(shareId)).toBe(1);
    text.insert(0, ">");
    await core.flush();
    expect((await database.stores.updates.read(shareId, 0)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await reload(shareId)).text).toBe(">hello world");
  });

  it("does not record or write while another instance owns the doc", async () => {
    const { shareId, core, text } = open();
    await core.load();
    text.insert(0, "follower edit");
    expect(core.pendingUpdates).toBe(0);
    await core.flush();
    expect(await database.stores.updates.lastSeq(shareId)).toBe(0);
  });

  it("compacts into a snapshot, keeps seq monotonic and loads snapshot plus later entries", async () => {
    const { shareId, core, text } = open(undefined, { compactAfter: 3 });
    core.owner = true;
    await core.load();
    for (const word of ["a", "b", "c"]) {
      text.insert(text.length, word);
      await core.flush();
    }
    expect(core.needsCompaction).toBe(true);
    await core.compact();
    expect(await database.stores.updates.read(shareId, 0)).toEqual([]);
    expect((await database.stores.snapshots.latest(shareId, "compact"))?.seq).toBe(3);

    text.insert(text.length, "d");
    await core.flush();
    expect((await database.stores.updates.read(shareId, 0)).map((e) => e.seq)).toEqual([4]);
    const { text: stored, loaded } = await reload(shareId);
    expect(stored).toBe("abcd");
    expect(loaded).toMatchObject({ seq: 4, rows: 1 });

    // A second instance continues after the snapshot even though the log was emptied.
    const next = open(shareId);
    next.core.owner = true;
    await next.core.load();
    expect(next.core.seq).toBe(4);
    expect(next.text.toString()).toBe("abcd");
  });

  it("keeps the buffer when a write fails and recovers from a seq taken by another writer", async () => {
    const { shareId, core, text } = open();
    core.owner = true;
    await core.load();
    // Another writer took seq 1 behind our back (e.g. an expired lock).
    const intruder = new Y.Doc();
    intruder.getText("file:main").insert(0, "theirs ");
    await database.stores.updates.append(
      shareId,
      [{ seq: 1, data: Y.encodeStateAsUpdate(intruder) }],
      new Date(),
    );
    text.insert(0, "ours");
    await expect(core.flush()).rejects.toThrow(/duplicate/);
    await core.flush();
    const stored = (await reload(shareId)).text;
    expect(stored).toContain("ours");
    expect(stored).toContain("theirs");
  });

  it("adopts ownership by merging stored state and writing its full state once", async () => {
    const shareId = generateShareId();
    const first = open(shareId);
    first.core.owner = true;
    await first.core.load();
    first.text.insert(0, "persisted by A. ");
    await first.core.flush();

    const second = open(shareId);
    await second.core.load();
    // Only in B's memory, e.g. typed while A was the writer and A crashed before syncing it.
    second.text.insert(second.text.length, "only in B.");
    await second.core.adopt();
    expect(second.core.owner).toBe(true);
    expect((await reload(shareId)).text).toBe("persisted by A. only in B.");
  });

  it("writes history snapshots only after activity", async () => {
    const { shareId, core, text } = open();
    core.owner = true;
    await core.load();
    await core.history(true);
    expect(await database.stores.snapshots.list(shareId, "history")).toEqual([]);
    text.insert(0, "v1");
    expect(core.historyDue).toBe(false);
    await core.history(true);
    const history = await database.stores.snapshots.list(shareId, "history");
    expect(history.map((h) => h.seq)).toEqual([1]);
  });

  it("tracks the encoded size closely enough for the size limit", async () => {
    const { core, text, doc } = open();
    core.owner = true;
    await core.load();
    text.insert(0, "x".repeat(10_000));
    expect(core.sizeEstimate).toBeGreaterThanOrEqual(10_000);
    text.delete(0, 9_000);
    expect(core.measure()).toBe(Y.encodeStateAsUpdate(doc).byteLength);
    expect(core.sizeEstimate).toBeLessThan(2_000);
  });
});
