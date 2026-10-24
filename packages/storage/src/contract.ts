import type { LabRecord, ShareRecord } from "@codesh/shared";
import { defaultSettings } from "@codesh/shared";
import { describe, expect, it } from "vitest";
import {
  DuplicateSeqError,
  FileTooLargeError,
  StorageCapacityError,
  type Stores,
} from "./types.js";

/** Behaviour every `Stores` implementation must have. `open` returns empty stores. */

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-01-01T00:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

function share(id: string, overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id,
    title: "Untitled",
    language: "typescript",
    ownerId: OWNER,
    createdAt: T0,
    updatedAt: T0,
    lastActiveAt: T0,
    expiresAt: later(24 * 3600_000),
    saved: false,
    savedBy: [],
    access: {
      default: "edit",
      editKey: "key",
      pinHash: null,
      requireApproval: false,
      nearby: true,
    },
    bans: [],
    joinCode: "123456",
    locked: false,
    sizeBytes: 0,
    ...overrides,
  };
}

function lab(id: string, overrides: Partial<LabRecord> = {}): LabRecord {
  return {
    id,
    title: "Lab",
    ownerId: OWNER,
    joinCode: "654321",
    templateShareId: null,
    locked: false,
    students: [],
    createdAt: T0,
    expiresAt: later(3600_000),
    ...overrides,
  };
}

export function storeContract(name: string, open: () => Promise<Stores>) {
  describe(name, () => {
    describe("ShareStore", () => {
      it("creates, reads and updates copies, not references", async () => {
        const { shares } = await open();
        const original = share("abcd1234");
        await shares.create(original);
        original.title = "mutated";
        expect((await shares.get("abcd1234"))?.title).toBe("Untitled");

        const updated = await shares.update("abcd1234", { title: "Renamed", locked: true });
        expect(updated).toMatchObject({ title: "Renamed", locked: true });
        expect(await shares.update("missing1", { title: "x" })).toBeNull();
      });

      it("merges access fields, so updates of different fields do not overwrite each other", async () => {
        const { shares } = await open();
        await shares.create(share("abcd1234"));
        await Promise.all([
          shares.update("abcd1234", { access: { pinHash: "scrypt$x" } }),
          shares.update("abcd1234", { access: { requireApproval: true, nearby: false } }),
          shares.update("abcd1234", { access: { editKey: "rotated" }, title: "Renamed" }),
        ]);
        expect(await shares.get("abcd1234")).toMatchObject({
          title: "Renamed",
          access: {
            default: "edit",
            editKey: "rotated",
            pinHash: "scrypt$x",
            requireApproval: true,
            nearby: false,
          },
        });
        const cleared = await shares.update("abcd1234", { access: { pinHash: null } });
        expect(cleared?.access).toMatchObject({ pinHash: null, requireApproval: true });
      });

      it("lists owned and saved shares newest first", async () => {
        const { shares } = await open();
        await shares.create(share("aaaaaaa1", { updatedAt: later(1000) }));
        await shares.create(share("aaaaaaa2", { updatedAt: later(3000) }));
        await shares.create(share("aaaaaaa3", { ownerId: OTHER, updatedAt: later(2000) }));
        await shares.create(share("aaaaaaa4", { ownerId: OTHER }));
        await shares.addSaved("aaaaaaa3", OWNER);

        const ids = (await shares.listForClient(OWNER)).map((s) => s.id);
        expect(ids).toEqual(["aaaaaaa2", "aaaaaaa3", "aaaaaaa1"]);
      });

      it("keeps a share alive while anyone has it saved", async () => {
        const { shares } = await open();
        await shares.create(share("abcd1234"));
        await shares.addSaved("abcd1234", OWNER);
        const saved = await shares.addSaved("abcd1234", OTHER);
        expect(saved).toMatchObject({ saved: true, expiresAt: null, savedBy: [OWNER, OTHER] });

        const expiry = later(48 * 3600_000);
        expect(await shares.removeSaved("abcd1234", OWNER, expiry)).toMatchObject({
          saved: true,
          expiresAt: null,
        });
        expect(await shares.removeSaved("abcd1234", OTHER, expiry)).toMatchObject({
          saved: false,
          expiresAt: expiry,
        });
      });

      it("touches activity without giving a saved share an expiry", async () => {
        const { shares } = await open();
        await shares.create(share("unsaved1"));
        await shares.create(share("saved001", { saved: true, savedBy: [OWNER], expiresAt: null }));
        const at = later(60_000);
        const expiry = later(25 * 3600_000);
        expect(await shares.touch("unsaved1", at, expiry, 42)).toBe(true);
        expect(await shares.touch("saved001", at, expiry)).toBe(true);
        expect(await shares.touch("missing1", at, expiry)).toBe(false);
        expect(await shares.get("unsaved1")).toMatchObject({
          lastActiveAt: at,
          updatedAt: at,
          expiresAt: expiry,
          sizeBytes: 42,
        });
        expect(await shares.get("saved001")).toMatchObject({
          lastActiveAt: at,
          expiresAt: null,
          sizeBytes: 0,
        });
      });

      it("tracks bans, labs and existence", async () => {
        const { shares } = await open();
        await shares.create(share("abcd1234", { labId: "lab00001" }));
        await shares.addBan("abcd1234", OTHER);
        await shares.addBan("abcd1234", OTHER);
        expect((await shares.get("abcd1234"))?.bans).toEqual([OTHER]);
        await shares.removeBan("abcd1234", OTHER);
        expect((await shares.get("abcd1234"))?.bans).toEqual([]);

        expect((await shares.listByLab("lab00001")).map((s) => s.id)).toEqual(["abcd1234"]);
        expect(await shares.existing(["abcd1234", "nope1234"])).toEqual(new Set(["abcd1234"]));
      });

      it("deletes expired shares but not saved ones", async () => {
        const { shares } = await open();
        await shares.create(share("expired1", { expiresAt: later(1000) }));
        await shares.create(share("kept0001", { expiresAt: later(10_000) }));
        await shares.create(share("saved001", { expiresAt: null, saved: true }));
        expect(await shares.deleteExpired(later(5000))).toEqual(["expired1"]);
        expect(await shares.get("expired1")).toBeNull();
        expect(await shares.delete("kept0001")).toBe(true);
        expect(await shares.delete("kept0001")).toBe(false);
      });
    });

    describe("UpdateLog", () => {
      const bytes = (...n: number[]) => new Uint8Array(n);

      it("appends and reads in seq order after a given seq", async () => {
        const { updates } = await open();
        expect(await updates.lastSeq("abcd1234")).toBe(0);
        await updates.append(
          "abcd1234",
          [
            { seq: 2, data: bytes(2) },
            { seq: 1, data: bytes(1) },
          ],
          T0,
        );
        await updates.append("abcd1234", [{ seq: 3, data: bytes(3) }], T0);

        expect((await updates.read("abcd1234", 0)).map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(await updates.read("abcd1234", 2)).toEqual([{ seq: 3, data: bytes(3) }]);
        expect(await updates.lastSeq("abcd1234")).toBe(3);
      });

      it("rejects a duplicate seq without storing any of the batch", async () => {
        const { updates } = await open();
        await updates.append("abcd1234", [{ seq: 1, data: bytes(1) }], T0);
        await expect(
          updates.append(
            "abcd1234",
            [
              { seq: 2, data: bytes(2) },
              { seq: 1, data: bytes(9) },
            ],
            T0,
          ),
        ).rejects.toBeInstanceOf(DuplicateSeqError);
        expect(await updates.lastSeq("abcd1234")).toBe(1);
      });

      it("compacts and clears", async () => {
        const { updates } = await open();
        await updates.append(
          "abcd1234",
          [1, 2, 3].map((seq) => ({ seq, data: bytes(seq) })),
          T0,
        );
        expect(await updates.deleteUpTo("abcd1234", 2)).toBe(2);
        expect((await updates.read("abcd1234", 0)).map((e) => e.seq)).toEqual([3]);
        expect(await updates.shareIds()).toEqual(["abcd1234"]);
        await updates.deleteForShare("abcd1234");
        expect(await updates.shareIds()).toEqual([]);
      });

      it("does not alias stored bytes", async () => {
        const { updates } = await open();
        const data = bytes(1, 2);
        await updates.append("abcd1234", [{ seq: 1, data }], T0);
        data[0] = 9;
        expect((await updates.read("abcd1234", 0))[0]?.data).toEqual(bytes(1, 2));
      });
    });

    describe("SnapshotStore", () => {
      it("finds the latest snapshot per kind and lists metadata", async () => {
        const { snapshots } = await open();
        const put = (seq: number, kind: "compact" | "history", at = T0) =>
          snapshots.put({ shareId: "abcd1234", seq, kind, at, state: new Uint8Array([seq]) });
        await put(10, "compact");
        await put(20, "compact");
        await put(15, "history", later(1000));
        await put(25, "history", later(2000));

        expect((await snapshots.latest("abcd1234", "compact"))?.seq).toBe(20);
        expect((await snapshots.get("abcd1234", "history", 15))?.state).toEqual(
          new Uint8Array([15]),
        );
        expect(await snapshots.get("abcd1234", "history", 20)).toBeNull();
        expect(await snapshots.list("abcd1234", "history")).toEqual([
          { seq: 15, at: later(1000) },
          { seq: 25, at: later(2000) },
        ]);
        expect(await snapshots.latest("other123", "compact")).toBeNull();
      });

      it("replaces a snapshot with the same key and prunes by seq and age", async () => {
        const { snapshots } = await open();
        const put = (seq: number, kind: "compact" | "history", at: Date) =>
          snapshots.put({ shareId: "abcd1234", seq, kind, at, state: new Uint8Array([seq]) });
        await put(1, "compact", T0);
        await put(1, "compact", later(5));
        await put(2, "compact", later(10));
        expect(await snapshots.list("abcd1234", "compact")).toHaveLength(2);

        expect(await snapshots.deleteBelow("abcd1234", "compact", 2)).toBe(1);
        await put(3, "history", T0);
        await put(4, "history", later(10_000));
        expect(await snapshots.deleteOlderThan("history", later(5000))).toBe(1);
        expect((await snapshots.list("abcd1234", "history")).map((s) => s.seq)).toEqual([4]);

        expect(await snapshots.shareIds()).toEqual(["abcd1234"]);
        await snapshots.deleteForShare("abcd1234");
        expect(await snapshots.shareIds()).toEqual([]);
      });

      it("keeps only the newest snapshots of one share and kind", async () => {
        const { snapshots } = await open();
        const put = (shareId: string, seq: number, kind: "compact" | "history") =>
          snapshots.put({ shareId, seq, kind, at: T0, state: new Uint8Array([seq]) });
        for (const seq of [5, 1, 4, 2, 3]) await put("abcd1234", seq, "history");
        await put("abcd1234", 1, "compact");
        await put("other123", 1, "history");

        expect(await snapshots.keepNewest("abcd1234", "history", 3)).toBe(2);
        expect((await snapshots.list("abcd1234", "history")).map((s) => s.seq)).toEqual([3, 4, 5]);
        expect(await snapshots.keepNewest("abcd1234", "history", 3)).toBe(0);
        expect(await snapshots.keepNewest("abcd1234", "history", 10)).toBe(0);
        expect(await snapshots.keepNewest("missing1", "history", 1)).toBe(0);
        expect(await snapshots.list("abcd1234", "compact")).toHaveLength(1);
        expect(await snapshots.list("other123", "history")).toHaveLength(1);
      });
    });

    describe("FileStore", () => {
      it("M3: reserves global upload bytes atomically and returns space after deletion", async () => {
        const { files } = await open();
        const input = (name: string) => ({
          name,
          ownerId: OWNER,
          expiresAt: later(1000),
          contentType: null,
          stream: (async function* () {
            yield new Uint8Array(6);
          })(),
        });
        const results = await Promise.allSettled([
          files.putStream(input("a"), 100, 10),
          files.putStream(input("b"), 100, 10),
        ]);
        const accepted = results.find((result) => result.status === "fulfilled");
        const refused = results.find((result) => result.status === "rejected");
        expect(accepted?.status).toBe("fulfilled");
        expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
          StorageCapacityError,
        );
        if (accepted?.status !== "fulfilled") throw new Error("missing upload");
        await files.delete(accepted.value.id);
        expect((await files.putStream(input("c"), 100, 10)).size).toBe(6);
      });

      const upload = (overrides = {}) => ({
        name: "a.txt",
        contentType: "text/plain",
        ownerId: OWNER,
        expiresAt: later(1000),
        data: new Uint8Array([1, 2, 3]),
        ...overrides,
      });

      it("stores bytes and returns metadata with id and size", async () => {
        const { files } = await open();
        const meta = await files.put(upload({ shareId: "abcd1234" }));
        expect(meta).toMatchObject({ name: "a.txt", size: 3, shareId: "abcd1234" });

        const found = await files.get(meta.id);
        expect(found?.data).toEqual(new Uint8Array([1, 2, 3]));
        expect(found?.meta).toEqual(meta);
        expect(await files.get("missing")).toBeNull();
      });

      it("reads metadata without the content, and streams the content out", async () => {
        const { files } = await open();
        const stored = await files.put(upload({ shareId: "abcd1234" }));
        expect(await files.meta(stored.id)).toEqual(stored);
        expect(await files.meta("missing")).toBeNull();

        const opened = await files.openDownload(stored.id);
        expect(opened?.meta).toEqual(stored);
        const chunks: Uint8Array[] = [];
        for await (const chunk of opened?.stream ?? []) chunks.push(chunk as Uint8Array);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
        expect(await files.openDownload("missing")).toBeNull();
      });

      it("stores a stream, enforces the size limit and leaves nothing behind", async () => {
        const { files } = await open();
        async function* chunks(count: number, size: number) {
          for (let i = 0; i < count; i++) yield new Uint8Array(size).fill(i + 1);
        }
        const { data: _data, ...fields } = upload({ shareId: "abcd1234" });
        const meta = await files.putStream({ ...fields, stream: chunks(3, 4) }, 12);
        expect(meta).toMatchObject({ name: "a.txt", size: 12, shareId: "abcd1234" });
        expect(await files.meta(meta.id)).toEqual(meta);
        const found = await files.get(meta.id);
        expect(Array.from(found?.data ?? [])).toEqual([
          ...Array(4).fill(1),
          ...Array(4).fill(2),
          ...Array(4).fill(3),
        ]);

        await expect(
          files.putStream({ ...fields, shareId: "toolarge", stream: chunks(3, 5) }, 12),
        ).rejects.toBeInstanceOf(FileTooLargeError);
        await expect(
          files.putStream({
            ...fields,
            shareId: "broken01",
            stream: (async function* () {
              yield new Uint8Array(3);
              throw new Error("connection lost");
            })(),
          }),
        ).rejects.toThrow("connection lost");
        expect(await files.shareIds()).toEqual(["abcd1234"]);
        expect(await files.deleteForShare("toolarge")).toBe(0);
        expect(await files.deleteForShare("broken01")).toBe(0);
      });

      it("deletes by id, share and expiry", async () => {
        const { files } = await open();
        const a = await files.put(upload({ shareId: "abcd1234" }));
        await files.put(upload({ shareId: "abcd1234" }));
        await files.put(upload({ expiresAt: later(9000) }));
        expect(await files.shareIds()).toEqual(["abcd1234"]);

        expect(await files.delete(a.id)).toBe(true);
        expect(await files.deleteForShare("abcd1234")).toBe(1);
        expect(await files.deleteExpired(later(5000))).toBe(0);
        expect(await files.deleteExpired(later(10_000))).toBe(1);
      });
    });

    describe("LabStore", () => {
      it("creates, updates and adds students idempotently", async () => {
        const { labs } = await open();
        await labs.create(lab("lab00001"));
        expect(
          await labs.update("lab00001", { locked: true, templateShareId: "abcd1234" }),
        ).toMatchObject({
          locked: true,
          templateShareId: "abcd1234",
        });

        const student = { clientId: OTHER, name: "Min", shareId: "abcd1234", joinedAt: T0 };
        await labs.addStudent("lab00001", student);
        const result = await labs.addStudent("lab00001", { ...student, name: "Minho" });
        expect(result?.students).toEqual([{ ...student, name: "Minho" }]);
        expect(await labs.addStudent("missing1", student)).toBeNull();
      });

      it("deletes expired labs", async () => {
        const { labs } = await open();
        await labs.create(lab("lab00001", { expiresAt: later(1000) }));
        await labs.create(lab("lab00002", { expiresAt: later(9000) }));
        expect(await labs.deleteExpired(later(5000))).toBe(1);
        expect(await labs.get("lab00001")).toBeNull();
        expect(await labs.delete("lab00002")).toBe(true);
      });
    });

    describe("LabelStore", () => {
      it("stores, replaces and deletes one person's labels for a share", async () => {
        const { labels } = await open();
        expect(await labels.get(OWNER, "abcd1234")).toBeNull();

        const stored = await labels.set(OWNER, "abcd1234", { folder: "Week 1", tags: ["a"] }, T0);
        expect(stored).toEqual({
          clientId: OWNER,
          shareId: "abcd1234",
          folder: "Week 1",
          tags: ["a"],
          updatedAt: T0,
        });
        const replaced = await labels.set(
          OWNER,
          "abcd1234",
          { folder: null, tags: ["b", "c"] },
          later(1000),
        );
        expect(replaced).toMatchObject({ folder: null, tags: ["b", "c"], updatedAt: later(1000) });
        expect(await labels.get(OWNER, "abcd1234")).toEqual(replaced);

        expect(await labels.delete(OWNER, "abcd1234")).toBe(true);
        expect(await labels.delete(OWNER, "abcd1234")).toBe(false);
        expect(await labels.get(OWNER, "abcd1234")).toBeNull();
      });

      it("keeps labels apart per person and per share", async () => {
        const { labels } = await open();
        await labels.set(OWNER, "abcd1234", { folder: "mine", tags: [] }, T0);
        await labels.set(OTHER, "abcd1234", { folder: "theirs", tags: ["x"] }, T0);
        await labels.set(OWNER, "wxyz5678", { folder: null, tags: ["y"] }, T0);

        expect((await labels.get(OTHER, "abcd1234"))?.folder).toBe("theirs");
        const mine = await labels.listForClient(OWNER);
        expect(mine.map((entry) => entry.shareId).sort()).toEqual(["abcd1234", "wxyz5678"]);
        expect(await labels.listForClient("33333333-3333-4333-8333-333333333333")).toEqual([]);
      });

      it("returns copies, not references", async () => {
        const { labels } = await open();
        const input = { folder: "f", tags: ["a"] };
        await labels.set(OWNER, "abcd1234", input, T0);
        input.tags.push("mutated");
        const read = await labels.get(OWNER, "abcd1234");
        read?.tags.push("mutated");
        expect((await labels.get(OWNER, "abcd1234"))?.tags).toEqual(["a"]);
      });

      it("removes every person's labels when a share goes, and lists the shares that have some", async () => {
        const { labels } = await open();
        await labels.set(OWNER, "abcd1234", { folder: "f", tags: [] }, T0);
        await labels.set(OTHER, "abcd1234", { folder: "g", tags: [] }, T0);
        await labels.set(OWNER, "wxyz5678", { folder: "f", tags: [] }, T0);

        expect((await labels.shareIds()).sort()).toEqual(["abcd1234", "wxyz5678"]);
        expect(await labels.deleteForShare("abcd1234")).toBe(2);
        expect(await labels.deleteForShare("abcd1234")).toBe(0);
        expect(await labels.shareIds()).toEqual(["wxyz5678"]);
        expect(await labels.get(OWNER, "wxyz5678")).not.toBeNull();
      });

      it("lists the clients that have some", async () => {
        const { labels } = await open();
        expect(await labels.clientIds()).toEqual([]);
        await labels.set(OWNER, "abcd1234", { folder: "f", tags: [] }, T0);
        await labels.set(OWNER, "wxyz5678", { folder: "f", tags: [] }, T0);
        await labels.set(OTHER, "abcd1234", { folder: "g", tags: [] }, T0);
        expect((await labels.clientIds()).sort()).toEqual([OWNER, OTHER]);
        await labels.delete(OTHER, "abcd1234");
        expect(await labels.clientIds()).toEqual([OWNER]);
      });
    });

    describe("SettingsStore", () => {
      it("returns defaults until something is stored", async () => {
        const { settings } = await open();
        expect(await settings.get()).toEqual(defaultSettings());
        await settings.put({
          ...defaultSettings(),
          contact: "it@example.org",
          guestAllowed: false,
        });
        expect(await settings.get()).toMatchObject({
          contact: "it@example.org",
          guestAllowed: false,
        });
      });

      it("stores templates and fills them in for documents written before they existed", async () => {
        const { settings } = await open();
        const templates = [
          {
            id: "org-service",
            name: "Service",
            language: "go",
            description: "Our service skeleton",
            files: [{ path: "main.go", content: "package main\n" }],
          },
        ];
        await settings.put({ ...defaultSettings(), templates });
        expect((await settings.get()).templates).toEqual(templates);
      });
    });

    describe("AuditStore", () => {
      it("lists newest first with limit and cursor, and prunes old entries", async () => {
        const { audit } = await open();
        for (const [i, action] of ["a", "b", "c"].entries()) {
          await audit.append({ at: later(i * 1000), actor: OWNER, ip: "10.0.0.1", action });
        }
        expect((await audit.list({ limit: 2 })).map((e) => e.action)).toEqual(["c", "b"]);
        expect((await audit.list({ limit: 10, before: later(2000) })).map((e) => e.action)).toEqual(
          ["b", "a"],
        );
        expect(await audit.deleteOlderThan(later(1000))).toBe(1);
        expect((await audit.list({ limit: 10 })).map((e) => e.action)).toEqual(["c", "b"]);
      });
    });
  });
}
