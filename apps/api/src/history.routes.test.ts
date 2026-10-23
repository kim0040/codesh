import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readContent } from "./docs.js";
import {
  createHarness,
  createShare,
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

  it("asks collab to restore the entry and mirrors its title and size in the record", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, {
      title: "Draft",
      files: [{ path: "main.py", content: "print('v1')\n" }],
    });
    await keepHistory(id, 1);
    await h.stores.shares.update(id, { title: "Final", sizeBytes: 999 });
    const lastSeqBefore = await h.stores.updates.lastSeq(id);
    h.collab.commands.length = 0;

    const response = await owner.post(`/api/shares/${id}/restore`, { seq: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    // The API only asks; collab writes the update (§6.11).
    expect(h.collab.commands).toMatchObject([{ kind: "restore", seq: 1 }]);
    expect(await h.stores.updates.lastSeq(id)).toBe(lastSeqBefore);
    expect(await h.stores.snapshots.list(id, "history")).toHaveLength(1);
    expect(await h.stores.shares.get(id)).toMatchObject({
      title: "Draft",
      sizeBytes: "print('v1')\n".length,
    });
  });

  it("changes nothing and answers 503 when collab does not reply", async () => {
    const quiet = await createHarness({ collab: "none", commandTimeoutMs: 150 });
    try {
      const owner = quiet.client();
      const { id } = await createShare(owner, { title: "Draft" });
      const doc = await storedDoc(quiet.stores, id);
      await quiet.stores.snapshots.put({
        shareId: id,
        seq: 1,
        state: new Uint8Array(Y.encodeStateAsUpdate(doc)),
        at: new Date(),
        kind: "history",
      });
      await quiet.stores.shares.update(id, { title: "Later" });

      const response = await owner.post(`/api/shares/${id}/restore`, { seq: 1 });
      expect(response.statusCode).toBe(503);
      expect(errorCode(response)).toBe("unavailable");
      expect(await quiet.stores.shares.get(id)).toMatchObject({ title: "Later" });
    } finally {
      await quiet.close();
    }
  });

  it("turns a refusal from collab into the matching error", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    await keepHistory(id, 1);
    const cases = [
      ["snapshot_not_found", 404, "not_found"],
      ["too_large", 413, "too_large"],
      ["failed", 503, "unavailable"],
    ] as const;
    try {
      for (const [error, status, code] of cases) {
        h.collab.reply = () => ({ ok: false, error });
        const response = await owner.post(`/api/shares/${id}/restore`, { seq: 1 });
        expect(response.statusCode, error).toBe(status);
        expect(errorCode(response), error).toBe(code);
      }
    } finally {
      h.collab.reply = () => ({ ok: true });
    }
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
