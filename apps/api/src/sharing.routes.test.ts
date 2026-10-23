import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

interface ListItem {
  id: string;
  title: string;
  language: string;
  role: string;
  saved: boolean;
  updatedAt: string;
  expiresAt: string | null;
  preview: string;
}

describe.skipIf(!integration)("save, unsave and GET /api/shares", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("saving keeps the share and its code forever; unsaving restarts the expiry", async () => {
    const owner = h.client();
    const { id, code } = await createShare(owner, { title: "Keep me" });
    const guest = h.client();
    const guestId = await guest.clientId();

    const saved = await guest.post(`/api/shares/${id}/save`);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ok: true });
    expect(await h.stores.shares.get(id)).toMatchObject({
      saved: true,
      expiresAt: null,
      savedBy: [guestId],
    });
    expect(await h.valkey.ttl(`code:${code}`)).toBe(-1);

    const unsaved = await guest.delete(`/api/shares/${id}/save`);
    expect(unsaved.statusCode).toBe(200);
    const share = await h.stores.shares.get(id);
    expect(share).toMatchObject({ saved: false, savedBy: [] });
    const hours = ((share?.expiresAt?.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect(await h.valkey.ttl(`code:${code}`)).toBeGreaterThan(86_000);
  });

  it("stays saved while any of several clients still has it saved", async () => {
    const { id } = await createShare(h.client());
    const a = h.client();
    const b = h.client();
    await a.post(`/api/shares/${id}/save`);
    await b.post(`/api/shares/${id}/save`);
    await a.delete(`/api/shares/${id}/save`);
    expect(await h.stores.shares.get(id)).toMatchObject({ saved: true, expiresAt: null });
    await b.delete(`/api/shares/${id}/save`);
    expect(await h.stores.shares.get(id)).toMatchObject({ saved: false });
  });

  it("answers 404 for an unknown share", async () => {
    const client = h.client();
    expect((await client.post("/api/shares/Zz9Zz9Zz/save")).statusCode).toBe(404);
    expect((await client.delete("/api/shares/Zz9Zz9Zz/save")).statusCode).toBe(404);
  });

  it("lists owned and saved shares newest first with role, language and a preview", async () => {
    const me = h.client();
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const first = await createShare(me, {
      title: "First",
      language: "python",
      files: [{ path: "a.py", content: lines }],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createShare(me, { title: "Second" });
    const theirs = await createShare(h.client(), { title: "Theirs" });
    await me.post(`/api/shares/${theirs.id}/save`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await me.patch(`/api/shares/${first.id}`, { title: "First (renamed)" });

    const response = await me.get("/api/shares");
    expect(response.statusCode).toBe(200);
    const items = response.json<ListItem[]>();
    expect(items.map((i) => i.id)).toEqual([first.id, theirs.id, second.id]);
    expect(items[0]).toMatchObject({
      title: "First (renamed)",
      language: "python",
      role: "owner",
      saved: false,
    });
    expect(items[0]?.preview).toBe(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n"));
    expect(items[1]).toMatchObject({ title: "Theirs", role: "edit", saved: true, expiresAt: null });
    expect(items[2]?.expiresAt).not.toBeNull();
    expect(new Date(items[0]?.updatedAt ?? "").getTime()).toBeGreaterThan(
      new Date(items[2]?.updatedAt ?? "").getTime(),
    );

    // Nobody else sees my shares.
    expect((await h.client().get("/api/shares")).json()).toEqual([]);
  });

  it("serves the preview from the share record instead of loading every document", async () => {
    const me = h.client();
    const { id } = await createShare(me, { files: [{ path: "a.txt", content: "one\ntwo\n" }] });
    const snapshots = h.stores.snapshots;
    const original = snapshots.latest.bind(snapshots);
    let loads = 0;
    snapshots.latest = async (...args) => {
      loads++;
      return original(...args);
    };
    try {
      // Cold Valkey cache (restart, flush, 60 s TTL): the record has the preview.
      await h.valkey.del(`preview:${id}`);
      expect((await me.get("/api/shares")).json<ListItem[]>()[0]?.preview).toBe("one\ntwo");
      expect(loads).toBe(0);

      // Activity (collab touches the share) makes the stored preview stale: it is read once more
      // and written back.
      await h.valkey.del(`preview:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await h.stores.shares.touch(id, new Date(), new Date(Date.now() + 10_000));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await me.get("/api/shares");
      expect(loads).toBeGreaterThan(0);
      const refreshed = await h.stores.shares.get(id);
      expect(refreshed?.preview).toBe("one\ntwo");
      expect(refreshed?.previewAt?.getTime()).toBeGreaterThan(Date.now() - 5000);
      const seen = loads;
      await h.valkey.del(`preview:${id}`);
      await me.get("/api/shares");
      expect(loads).toBe(seen);
    } finally {
      snapshots.latest = original;
    }
  });

  it("leaves out shares that already expired", async () => {
    const me = h.client();
    const { id } = await createShare(me);
    await h.stores.shares.update(id, { expiresAt: new Date(Date.now() - 1000) });
    expect((await me.get("/api/shares")).json()).toEqual([]);
  });
});

describe.skipIf(!integration)("POST /api/shares/:id/fork", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("copies the current content into a new share owned by the forker", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, {
      title: "Template",
      language: "typescript",
      files: [
        { path: "index.ts", content: "export const a = 1;\n" },
        { path: "lib/util.ts", content: "export const b = 2;\n" },
      ],
    });
    const forker = h.client();
    const forkerId = await forker.clientId();

    const response = await forker.post(`/api/shares/${id}/fork`);
    expect(response.statusCode).toBe(200);
    const fork = response.json<{ id: string; code: string; url: string }>();
    expect(fork.id).not.toBe(id);
    expect(fork.code).not.toBe((await h.stores.shares.get(id))?.joinCode);
    expect(await h.valkey.get(`code:${fork.code}`)).toBe(fork.id);

    const record = await h.stores.shares.get(fork.id);
    expect(record).toMatchObject({
      ownerId: forkerId,
      forkOf: id,
      title: "Template",
      language: "typescript",
    });
    const original = readContent(await storedDoc(h.stores, id));
    const copy = readContent(await storedDoc(h.stores, fork.id));
    expect(copy.files.map((f) => [f.path, f.language, f.content])).toEqual(
      original.files.map((f) => [f.path, f.language, f.content]),
    );

    // The fork is independent: the forker owns it and the original keeps its owner.
    expect((await forker.get(`/api/shares/${fork.id}`)).json<{ role: string }>().role).toBe(
      "owner",
    );
    expect((await h.stores.shares.get(id))?.ownerId).not.toBe(forkerId);
  });

  it("answers 404 for an unknown share", async () => {
    expect((await h.client().post("/api/shares/Zz9Zz9Zz/fork")).statusCode).toBe(404);
  });
});

describe.skipIf(!integration)("GET /api/shares/:id/download", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const files = [
    { path: "src/main.py", content: "print('안녕')\n" },
    { path: "README.md", content: "# Demo\n" },
  ];

  it("returns one file as an attachment named after it", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Demo", files });
    const response = await h.client().get(`/api/shares/${id}/download?file=main`);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toMatch(/^text\/plain; charset=utf-8/);
    expect(String(response.headers["content-disposition"])).toMatch(
      /^attachment; filename="main\.py"/,
    );
    expect(response.body).toBe("print('안녕')\n");
  });

  it("returns a zip of all files when no file is given", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Demo", files });
    const response = await h.client().get(`/api/shares/${id}/download`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(String(response.headers["content-disposition"])).toMatch(
      /^attachment; filename="Demo\.zip"/,
    );
    const unzipped = unzipSync(new Uint8Array(response.rawPayload));
    expect(Object.keys(unzipped).sort()).toEqual(["README.md", "src/main.py"]);
    expect(strFromU8(unzipped["src/main.py"] as Uint8Array)).toBe("print('안녕')\n");
    expect(strFromU8(unzipped["README.md"] as Uint8Array)).toBe("# Demo\n");
  });

  it("answers 404 for a file the share does not have and for a missing share", async () => {
    const { id } = await createShare(h.client(), { files });
    const client = h.client();
    const missingFile = await client.get(`/api/shares/${id}/download?file=Zz9Zz9Zz`);
    expect(missingFile.statusCode).toBe(404);
    expect(errorCode(missingFile)).toBe("not_found");
    expect((await client.get("/api/shares/Zz9Zz9Zz/download")).statusCode).toBe(404);
    expect((await client.get(`/api/shares/${id}/download?file=not valid`)).statusCode).toBe(400);
  });

  it("records the download in the audit log when auditing is on", async () => {
    await h.stores.settings.put({
      ...(await h.stores.settings.get()),
      audit: { enabled: true, retentionDays: 90 },
    });
    const { id } = await createShare(h.client(), { files });
    const client = h.client();
    const clientId = await client.clientId();
    await client.get(`/api/shares/${id}/download`);
    const entries = await h.stores.audit.list({ limit: 50 });
    const entry = entries.find((e) => e.action === "share.download" && e.shareId === id);
    expect(entry).toMatchObject({ actor: clientId, ip: client.ip });
    await h.stores.settings.put({
      ...(await h.stores.settings.get()),
      audit: { enabled: false, retentionDays: 90 },
    });
  });
});
