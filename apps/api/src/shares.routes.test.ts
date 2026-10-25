import { channels, verifyCollabToken } from "@codesh/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readContent } from "./docs.js";
import {
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
  storedDoc,
} from "./testing/harness.js";

interface ShareView {
  id: string;
  title: string;
  language: string;
  joinCode: string;
  expiresAt: string | null;
  saved: boolean;
  locked: boolean;
  role: "owner" | "edit" | "view" | null;
  needsPin: boolean;
  requireApproval: boolean;
  access?: {
    default: string;
    hasPin: boolean;
    requireApproval: boolean;
    nearby: boolean;
    editKey: string;
  };
}

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe.skipIf(!integration)("POST /api/shares", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("creates a share with owner, code, expiry, edit key and an initial snapshot", async () => {
    const owner = h.client();
    const ownerId = await owner.clientId();
    const response = await owner.post("/api/shares");
    expect(response.statusCode).toBe(200);
    const { id, code, url } = response.json<{ id: string; code: string; url: string }>();
    expect(id).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(id).toMatch(/[A-Za-z]/);
    expect(code).toMatch(/^[1-9][0-9]{5}$/);
    expect(url).toBe(`/${id}`);

    const share = await h.stores.shares.get(id);
    expect(share).toMatchObject({
      ownerId,
      title: "",
      locked: false,
      saved: false,
      joinCode: code,
      access: { default: "edit", pinHash: null, requireApproval: false },
    });
    expect(share?.access.editKey).toHaveLength(24);
    const settings = await h.stores.settings.get();
    expect(share?.access.nearby).toBe(settings.nearbyDefault);
    const hours = ((share?.expiresAt?.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(settings.anonymousTtlHours - 0.1);
    expect(hours).toBeLessThanOrEqual(settings.anonymousTtlHours);

    // The code lives in Valkey with a TTL and points back at the share.
    expect(await h.valkey.get(`code:${code}`)).toBe(id);
    const ttl = await h.valkey.ttl(`code:${code}`);
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);

    // The first snapshot already holds the document structure of §4.
    const snapshot = await h.stores.snapshots.latest(id, "compact");
    expect(snapshot?.seq).toBe(0);
    const content = readContent(await storedDoc(h.stores, id));
    expect(content.files).toHaveLength(1);
    expect(content.files[0]).toMatchObject({ id: "main", content: "" });
  });

  it("builds the document from the given files, title and language", async () => {
    const client = h.client();
    const { id } = await createShare(client, {
      title: "Sorting",
      language: "python",
      files: [
        { path: "main.py", content: "def sort(xs):\n    return sorted(xs)\n" },
        { path: "tests/test_sort.py", language: "python", content: "assert True\n" },
      ],
    });
    const content = readContent(await storedDoc(h.stores, id));
    expect(content.title).toBe("Sorting");
    expect(content.language).toBe("python");
    expect(content.files.map((f) => [f.id === "main", f.path, f.language, f.content])).toEqual([
      [true, "main.py", "python", "def sort(xs):\n    return sorted(xs)\n"],
      [false, "tests/test_sort.py", "python", "assert True\n"],
    ]);
    const share = await h.stores.shares.get(id);
    expect(share?.title).toBe("Sorting");
    expect(share?.sizeBytes).toBe(
      Buffer.byteLength("def sort(xs):\n    return sorted(xs)\n") +
        Buffer.byteLength("assert True\n"),
    );
  });

  it("accepts text above Fastify's default 1 MiB body limit, up to maxDocBytes", async () => {
    const client = h.client();
    const content = "0123456789abcdef\n".repeat(120_000); // about 2 MB
    const { id } = await createShare(client, { files: [{ path: "big.txt", content }] });
    expect((await h.stores.shares.get(id))?.sizeBytes).toBe(Buffer.byteLength(content));
    expect(readContent(await storedDoc(h.stores, id)).files[0]?.content).toBe(content);
  });

  it("rejects unsafe or duplicate paths with validation", async () => {
    const client = h.client();
    for (const files of [
      [{ path: "../etc/passwd", content: "x" }],
      [
        { path: "a.txt", content: "1" },
        { path: "./a.txt", content: "2" },
      ],
    ]) {
      const response = await client.post("/api/shares", { files });
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe("validation");
    }
  });

  it("answers 413 too_large when the text exceeds settings.maxDocBytes", async () => {
    const small = await createHarness();
    try {
      await small.stores.settings.put({ ...(await small.stores.settings.get()), maxDocBytes: 100 });
      const response = await small
        .client()
        .post("/api/shares", { files: [{ path: "big.txt", content: "x".repeat(101) }] });
      expect(response.statusCode).toBe(413);
      expect(errorCode(response)).toBe("too_large");
      const ok = await small
        .client()
        .post("/api/shares", { files: [{ path: "ok.txt", content: "x".repeat(100) }] });
      expect(ok.statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });

  it("prefixes the url with PUBLIC_URL when configured", async () => {
    const configured = await createHarness({ config: { publicUrl: "https://codesh.corp" } });
    try {
      const { id, url } = await createShare(configured.client());
      expect(url).toBe(`https://codesh.corp/${id}`);
    } finally {
      await configured.close();
    }
  });

  it("announces the share in the creator's network group unless nearby is off", async () => {
    const client = h.client();
    const { id } = await createShare(client);
    const net = `${client.ip.split(".").slice(0, 3).join(".")}.0/24`;
    expect(await h.valkey.zscore(`nearby:${net}`, id)).not.toBeNull();
    expect(await h.valkey.hget(`nearby:item:${id}`, "id")).toBe(id);
  });
});

describe.skipIf(!integration)("GET /api/shares/:id", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("shows the owner their role and the access settings including the edit key", async () => {
    const owner = h.client();
    const { id, code } = await createShare(owner, { title: "Mine", language: "go" });
    const response = await owner.get(`/api/shares/${id}`);
    expect(response.statusCode).toBe(200);
    const view = response.json<ShareView>();
    expect(view).toMatchObject({
      id,
      title: "Mine",
      language: "go",
      joinCode: code,
      role: "owner",
      needsPin: false,
      requireApproval: false,
      saved: false,
      locked: false,
    });
    const share = await h.stores.shares.get(id);
    expect(view.access).toEqual({
      allowParticipantRename: false,
      allowParticipantFiles: false,
      allowParticipantLanguage: false,
      default: "edit",
      hasPin: false,
      requireApproval: false,
      nearby: share?.access.nearby,
      editKey: share?.access.editKey,
    });
    expect(JSON.stringify(view)).not.toContain("pinHash");
  });

  it("shows others the default role and no access settings", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Public" });
    const visitor = h.client();
    const view = (await visitor.get(`/api/shares/${id}`)).json<ShareView>();
    expect(view.role).toBe("edit");
    expect(view.title).toBe("Public");
    expect(view.access).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain((await h.stores.shares.get(id))?.access.editKey);
  });

  it("answers 404 for an unknown id and 410 expired for an expired share", async () => {
    const client = h.client();
    const missing = await client.get("/api/shares/Zz9Zz9Zz");
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");

    const { id } = await createShare(client);
    await h.stores.shares.update(id, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await client.get(`/api/shares/${id}`);
    expect(expired.statusCode).toBe(410);
    expect(errorCode(expired)).toBe("expired");
  });
});

describe.skipIf(!integration)("PATCH /api/shares/:id", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("changes title and language in the record and asks collab to change the document", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Old", language: "python" });
    h.collab.commands.length = 0;
    const response = await owner.patch(`/api/shares/${id}`, { title: "New", language: "go" });
    expect(response.statusCode).toBe(200);
    expect(response.json<ShareView>()).toMatchObject({
      title: "New",
      language: "go",
      role: "owner",
    });

    expect(await h.stores.shares.get(id)).toMatchObject({ title: "New", language: "go" });
    expect(h.collab.commands).toMatchObject([{ kind: "meta", title: "New", language: "go" }]);
    // Only collab writes the update log (§6.11).
    expect(await h.stores.updates.lastSeq(id)).toBe(0);
  });

  it("sends no command for changes that are not document content", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    h.collab.commands.length = 0;
    expect((await owner.patch(`/api/shares/${id}`, { locked: true })).statusCode).toBe(200);
    expect(h.collab.commands).toEqual([]);
  });

  it("leaves the share unchanged and answers 503 when collab does not reply", async () => {
    const quiet = await createHarness({ collab: "none", commandTimeoutMs: 150 });
    try {
      const owner = quiet.client();
      const { id } = await createShare(owner, { title: "Old" });
      const response = await owner.patch(`/api/shares/${id}`, { title: "New" });
      expect(response.statusCode, response.body).toBe(503);
      expect(errorCode(response)).toBe("unavailable");
      expect((await quiet.stores.shares.get(id))?.title).toBe("Old");
    } finally {
      await quiet.close();
    }
  });

  it("is for the owner only and validates the body", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const other = h.client();
    const denied = await other.patch(`/api/shares/${id}`, { title: "hijack" });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("forbidden");
    expect((await h.stores.shares.get(id))?.title).toBe("");

    const invalid = await owner.patch(`/api/shares/${id}`, { access: { pin: "12" } });
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid)).toBe("validation");
    expect((await owner.patch("/api/shares/Zz9Zz9Zz", { title: "x" })).statusCode).toBe(404);
  });

  it("changes access, publishes a role change, and keeps the edit key secret from others", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const perm = await h.subscribe(channels.perm(id));
    const before = (await h.stores.shares.get(id))?.access.editKey;

    const response = await owner.patch(`/api/shares/${id}`, {
      access: { default: "view", requireApproval: true, rotateEditKey: true },
    });
    expect(response.statusCode).toBe(200);
    const share = await h.stores.shares.get(id);
    expect(share?.access).toMatchObject({ default: "view", requireApproval: true, pinHash: null });
    expect(share?.access.editKey).not.toBe(before);
    expect(response.json<ShareView>().access?.editKey).toBe(share?.access.editKey);

    const message = await eventually(() => perm.messages[0]);
    expect(message).toMatchObject({ kind: "role", version: 1 });
    perm.stop();
  });

  it("stores a PIN as a scrypt hash and never as the PIN itself", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const response = await owner.patch(`/api/shares/${id}`, { access: { pin: "482913" } });
    expect(response.statusCode).toBe(200);
    expect(response.json<ShareView>().access?.hasPin).toBe(true);
    expect(response.body).not.toContain("482913");
    const hash = (await h.stores.shares.get(id))?.access.pinHash;
    expect(hash?.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("482913");

    const removed = await owner.patch(`/api/shares/${id}`, { access: { pin: null } });
    expect(removed.json<ShareView>().access?.hasPin).toBe(false);
    expect((await h.stores.shares.get(id))?.access.pinHash).toBeNull();
  });

  it("keeps both changes of concurrent access PATCHes, the slow PIN hash included", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const before = (await h.stores.shares.get(id))?.access.editKey;
    const [pin, approval, rotate] = await Promise.all([
      owner.patch(`/api/shares/${id}`, { access: { pin: "482913" } }),
      owner.patch(`/api/shares/${id}`, { access: { requireApproval: true } }),
      owner.patch(`/api/shares/${id}`, { access: { rotateEditKey: true } }),
    ]);
    expect([pin.statusCode, approval.statusCode, rotate.statusCode]).toEqual([200, 200, 200]);
    const { access } = (await h.stores.shares.get(id)) ?? {};
    expect(access?.pinHash?.startsWith("scrypt$")).toBe(true);
    expect(access?.requireApproval).toBe(true);
    expect(access?.editKey).not.toBe(before);
    expect(access?.nearby).toBe(false);
  });

  it("keeps the PIN out of the audit log and records whether one was set", async () => {
    await h.stores.settings.put({
      ...(await h.stores.settings.get()),
      audit: { enabled: true, retentionDays: 90 },
    });
    const owner = h.client();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, { access: { pin: "482913", requireApproval: true } });
    await owner.patch(`/api/shares/${id}`, { access: { pin: null } });
    const entries = (await h.stores.audit.list({ limit: 50 })).filter(
      (entry) => entry.action === "share.update" && entry.shareId === id,
    );
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain("482913");
    expect(entries.map((entry) => entry.detail)).toEqual(
      expect.arrayContaining([
        { access: { requireApproval: true, hasPin: true } },
        { access: { hasPin: false } },
      ]),
    );
    await h.stores.settings.put({
      ...(await h.stores.settings.get()),
      audit: { enabled: false, retentionDays: 90 },
    });
  });

  it("turns nearby off for protected shares and removes the nearby entry", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const net = `${owner.ip.split(".").slice(0, 3).join(".")}.0/24`;
    expect(await h.valkey.zscore(`nearby:${net}`, id)).not.toBeNull();

    const response = await owner.patch(`/api/shares/${id}`, {
      access: { pin: "1234", nearby: true },
    });
    expect(response.json<ShareView>().access?.nearby).toBe(false);
    expect(await h.valkey.zscore(`nearby:${net}`, id)).toBeNull();
    expect(await h.valkey.exists(`nearby:item:${id}`)).toBe(0);

    await owner.patch(`/api/shares/${id}`, { access: { pin: null, nearby: true } });
    expect(await h.valkey.zscore(`nearby:${net}`, id)).not.toBeNull();
  });

  it("locks a share: participants become viewers, the owner keeps writing, collab is told", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const guest = h.client();
    const perm = await h.subscribe(channels.perm(id));

    const response = await owner.patch(`/api/shares/${id}`, { locked: true });
    expect(response.statusCode).toBe(200);
    expect(response.json<ShareView>().locked).toBe(true);
    expect((await h.stores.shares.get(id))?.locked).toBe(true);
    expect(await eventually(() => perm.messages[0])).toMatchObject({ kind: "lock" });

    const guestJoin = await guest.post(`/api/shares/${id}/join`);
    expect(guestJoin.json<{ role: string }>().role).toBe("view");
    const ownerJoin = await owner.post(`/api/shares/${id}/join`);
    expect(ownerJoin.json<{ role: string }>().role).toBe("owner");

    await owner.patch(`/api/shares/${id}`, { locked: false });
    expect((await guest.post(`/api/shares/${id}/join`)).json<{ role: string }>().role).toBe("edit");
    perm.stop();
  });

  it("saves and unsaves for the owner and moves expiresAt accordingly", async () => {
    const owner = h.client();
    const ownerId = await owner.clientId();
    const { id, code } = await createShare(owner);

    const saved = await owner.patch(`/api/shares/${id}`, { saved: true });
    expect(saved.json<ShareView>()).toMatchObject({ saved: true, expiresAt: null });
    expect(await h.stores.shares.get(id)).toMatchObject({
      saved: true,
      expiresAt: null,
      savedBy: [ownerId],
    });
    // A saved share never expires, so its join code must not either.
    expect(await h.valkey.ttl(`code:${code}`)).toBe(-1);
    expect(await h.valkey.zscore("shares:index", id)).toBe("inf");

    const unsaved = await owner.patch(`/api/shares/${id}`, { saved: false });
    expect(unsaved.json<ShareView>().saved).toBe(false);
    const share = await h.stores.shares.get(id);
    expect(share?.saved).toBe(false);
    expect(share?.expiresAt).not.toBeNull();
    expect(await h.valkey.ttl(`code:${code}`)).toBeGreaterThan(0);
  });
});

describe.skipIf(!integration)("DELETE /api/shares/:id", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("removes everything, tells collab, and blocks the join code for 24 hours", async () => {
    const owner = h.client();
    const { id, code } = await createShare(owner, {
      files: [{ path: "a.txt", content: "bye" }],
    });
    await h.stores.files.put({
      name: "att.bin",
      contentType: null,
      ownerId: await owner.clientId(),
      shareId: id,
      expiresAt: new Date(Date.now() + 60_000),
      data: new Uint8Array([1, 2, 3]),
    });
    const perm = await h.subscribe(channels.perm(id));

    const response = await owner.delete(`/api/shares/${id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    expect(await h.stores.shares.get(id)).toBeNull();
    expect(await h.stores.snapshots.latest(id, "compact")).toBeNull();
    expect(await h.stores.updates.lastSeq(id)).toBe(0);
    expect(await h.stores.files.shareIds()).not.toContain(id);
    expect(await eventually(() => perm.messages[0])).toMatchObject({ kind: "delete" });

    expect(await h.valkey.get(`code:${code}`)).toBeNull();
    const cooldown = await h.valkey.ttl(`code:cool:${code}`);
    expect(cooldown).toBeGreaterThan(86_000);
    expect(cooldown).toBeLessThanOrEqual(86_400);
    expect(await h.valkey.zscore("shares:index", id)).toBeNull();

    const gone = await owner.get(`/api/shares/${id}`);
    expect(gone.statusCode).toBe(404);
    perm.stop();
  });

  it("is for the owner only", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const denied = await h.client().delete(`/api/shares/${id}`);
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("forbidden");
    expect(await h.stores.shares.get(id)).not.toBeNull();
    expect((await owner.delete("/api/shares/Zz9Zz9Zz")).statusCode).toBe(404);
  });
});

describe.skipIf(!integration)("collab tokens", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("signs shareId, client, display name, color, role and a 10 minute expiry (§8)", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const guest = h.client();
    await guest.patch("/api/session", { name: "Guest One", color: "#445566" });
    const guestId = await guest.clientId();

    const before = Math.floor(Date.now() / 1000);
    const response = await guest.post(`/api/shares/${id}/join`);
    expect(response.statusCode).toBe(200);
    const { token, role } = response.json<{ token: string; role: string }>();
    expect(role).toBe("edit");
    const payload = await verifyCollabToken(token, h.config.collabSecret);
    expect(payload).toEqual({
      shareId: id,
      clientId: guestId,
      name: "Guest One",
      color: "#445566",
      role: "edit",
      controller: false,
      generation: "",
      exp: expect.any(Number),
    });
    expect((payload?.exp ?? 0) - before).toBeGreaterThanOrEqual(599);
    expect((payload?.exp ?? 0) - before).toBeLessThanOrEqual(601);
    expect(await verifyCollabToken(token, "another-secret")).toBeNull();
  });

  it("uses a guest name when the visitor never chose one, and the owner role for the owner", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const ownerId = await owner.clientId();
    const { token, role } = (await owner.post(`/api/shares/${id}/join`)).json<{
      token: string;
      role: string;
    }>();
    expect(role).toBe("owner");
    expect(await verifyCollabToken(token, h.config.collabSecret)).toMatchObject({
      clientId: ownerId,
      name: `Guest-${ownerId.slice(0, 4)}`,
      role: "owner",
    });
  });

  it("answers 404 for an unknown share and 410 for an expired one", async () => {
    const client = h.client();
    expect((await client.post("/api/shares/Zz9Zz9Zz/join")).statusCode).toBe(404);
    const { id } = await createShare(client);
    await h.stores.shares.update(id, { expiresAt: new Date(Date.now() - 1) });
    const expired = await h.client().post(`/api/shares/${id}/join`);
    expect(expired.statusCode).toBe(410);
    expect(errorCode(expired)).toBe("expired");
  });
});
