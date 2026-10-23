import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readContent } from "./docs.js";
import {
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
  storedDoc,
} from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe.skipIf(!integration)("history and restore", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  /** Plays collab: edits the stored document and appends the change to the update log. */
  async function edit(id: string, change: (doc: Y.Doc) => void) {
    const doc = await storedDoc(h.stores, id);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => change(doc));
    const seq = (await h.stores.updates.lastSeq(id)) + 1;
    await h.stores.updates.append(
      id,
      [{ seq, data: Y.encodeStateAsUpdate(doc, before) }],
      new Date(),
    );
  }

  async function keepHistory(id: string, seq: number, at = new Date()) {
    const doc = await storedDoc(h.stores, id);
    await h.stores.snapshots.put({
      shareId: id,
      seq,
      state: new Uint8Array(Y.encodeStateAsUpdate(doc)),
      at,
      kind: "history",
    });
    return doc;
  }

  it("lists the history entries for the owner, oldest first", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { files: [{ path: "a.txt", content: "one" }] });
    expect((await owner.get(`/api/shares/${id}/history`)).json()).toEqual([]);

    const t1 = new Date("2026-10-01T10:00:00.000Z");
    const t2 = new Date("2026-10-01T10:00:30.000Z");
    await keepHistory(id, 3, t1);
    await keepHistory(id, 9, t2);
    const response = await owner.get(`/api/shares/${id}/history`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { seq: 3, at: t1.toISOString() },
      { seq: 9, at: t2.toISOString() },
    ]);
  });

  it("returns the stored state of one entry as binary", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { files: [{ path: "a.txt", content: "one" }] });
    const past = await keepHistory(id, 4);
    const response = await owner.get(`/api/shares/${id}/history/4`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    const copy = new Y.Doc();
    Y.applyUpdate(copy, new Uint8Array(response.rawPayload));
    expect(readContent(copy)).toEqual(readContent(past));

    const missing = await owner.get(`/api/shares/${id}/history/99`);
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");
  });

  it("keeps history away from everyone but the owner", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    await keepHistory(id, 1);
    const guest = h.client();
    for (const response of [
      await guest.get(`/api/shares/${id}/history`),
      await guest.get(`/api/shares/${id}/history/1`),
      await guest.post(`/api/shares/${id}/restore`, { seq: 1 }),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe("forbidden");
    }
  });

  it("restores an earlier state as a normal update on top of the current one", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, {
      title: "Draft",
      files: [
        { path: "main.py", content: "print('v1')\n" },
        { path: "old.py", content: "legacy = True\n" },
      ],
    });
    await keepHistory(id, 1);
    const v1 = readContent(await storedDoc(h.stores, id));

    // Later edits: change main, delete old.py, add new.py, retitle.
    await edit(id, (doc) => {
      doc.getText("file:main").insert(0, "# v2\n");
      doc.getMap("meta").set("title", "Final");
      const oldId = v1.files[1]?.id as string;
      doc.getMap("files").delete(oldId);
      const entry = new Y.Map<unknown>();
      doc.getMap("files").set("NEWFILE1", entry);
      entry.set("path", "new.py");
      entry.set("language", "python");
      entry.set("order", 2);
      doc.getText("file:NEWFILE1").insert(0, "added = True\n");
    });
    const beforeRestore = await storedDoc(h.stores, id);
    expect(readContent(beforeRestore).title).toBe("Final");
    const docChannel = await h.subscribe(`doc:${id}`);
    const lastSeqBefore = await h.stores.updates.lastSeq(id);

    const response = await owner.post(`/api/shares/${id}/restore`, { seq: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    // The stored document now reads like the old one.
    const restored = readContent(await storedDoc(h.stores, id));
    expect(restored.title).toBe("Draft");
    expect(restored.files.map((f) => [f.id, f.path, f.content])).toEqual(
      v1.files.map((f) => [f.id, f.path, f.content]),
    );
    // It is one more entry in the log, and history is still there.
    expect(await h.stores.updates.lastSeq(id)).toBe(lastSeqBefore + 1);
    expect((await h.stores.snapshots.list(id, "history")).map((s) => s.seq)).toEqual([1]);
    expect(await h.stores.shares.get(id)).toMatchObject({ title: "Draft" });

    // A live client holding the pre-restore state converges by applying that one update.
    const entries = await h.stores.updates.read(id, lastSeqBefore);
    expect(entries).toHaveLength(1);
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(beforeRestore));
    Y.applyUpdate(live, (entries[0] as { data: Uint8Array }).data);
    expect(readContent(live)).toEqual(restored);

    // And collab instances holding the document are sent the same update.
    const message = (await eventually(() => docChannel.messages[0])) as { update: string };
    const viaChannel = new Y.Doc();
    Y.applyUpdate(viaChannel, Y.encodeStateAsUpdate(beforeRestore));
    Y.applyUpdate(viaChannel, new Uint8Array(Buffer.from(message.update, "base64")));
    expect(readContent(viaChannel)).toEqual(restored);
    docChannel.stop();
  });

  it("numbers the restore update above the newest compact snapshot", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { files: [{ path: "a.txt", content: "one" }] });
    await keepHistory(id, 1);
    await edit(id, (doc) => doc.getText("file:main").insert(3, " two"));
    // Collab compacted: the snapshot at seq 1 holds everything and the log was emptied.
    const doc = await storedDoc(h.stores, id);
    await h.stores.snapshots.put({
      shareId: id,
      seq: 7,
      state: new Uint8Array(Y.encodeStateAsUpdate(doc)),
      at: new Date(),
      kind: "compact",
    });
    await h.stores.updates.deleteUpTo(id, 7);

    expect((await owner.post(`/api/shares/${id}/restore`, { seq: 1 })).statusCode).toBe(200);
    expect(await h.stores.updates.lastSeq(id)).toBe(8);
    expect(readContent(await storedDoc(h.stores, id)).files[0]?.content).toBe("one");
  });

  it("answers 404 for an unknown history entry and validates the body", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const missing = await owner.post(`/api/shares/${id}/restore`, { seq: 42 });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");
    expect((await owner.post(`/api/shares/${id}/restore`, { seq: -1 })).statusCode).toBe(400);
    expect((await owner.post(`/api/shares/${id}/restore`, {})).statusCode).toBe(400);
  });
});
