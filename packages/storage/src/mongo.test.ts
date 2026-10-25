import { Binary, Collection, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storeContract } from "./contract.js";
import { COLLECTIONS, ensureIndexes } from "./mongo.js";
import { createTestDatabase, mongoAvailable, type TestDatabase } from "./testing.js";

const available = await mongoAvailable();

describe.runIf(available)("MongoDB stores", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database?.drop());

  storeContract("contract", () => database.reset());

  it("creates the §5 indexes idempotently", async () => {
    const { db } = database;
    await ensureIndexes(db);
    await ensureIndexes(db);

    const names = async (collection: string) =>
      (await db.collection(collection).indexes()).map((index) => index.name);
    const shareIndexes = await db.collection(COLLECTIONS.shares).indexes();
    expect(shareIndexes.find((i) => i.name === "expiresAt_ttl")?.expireAfterSeconds).toBe(0);
    expect(await names(COLLECTIONS.shares)).toEqual(
      expect.arrayContaining(["ownerId", "savedBy", "labId", "createdAt_id_desc"]),
    );
    const updates = await db.collection(COLLECTIONS.updates).indexes();
    expect(updates.find((i) => i.name === "shareId_seq")?.unique).toBe(true);
    const labs = await db.collection(COLLECTIONS.labs).indexes();
    expect(labs.find((i) => i.name === "expiresAt_ttl")?.expireAfterSeconds).toBe(0);
    expect(await names(COLLECTIONS.labels)).toEqual(
      expect.arrayContaining(["clientId", "shareId"]),
    );
    expect(await names(COLLECTIONS.audit)).toContain("at_desc");
    expect(await names("uploads.files")).toContain("metadata_expiresAt");
  });

  it("stores binary updates as BSON binary and reads plain Uint8Array back", async () => {
    const stores = await database.reset();
    await stores.updates.append(
      "abcd1234",
      [{ seq: 1, data: new Uint8Array([0, 255, 7]) }],
      new Date(),
    );
    const [entry] = await stores.updates.read("abcd1234", 0);
    expect(entry?.data).toBeInstanceOf(Uint8Array);
    expect(entry?.data.constructor).toBe(Uint8Array);
    expect([...(entry?.data ?? [])]).toEqual([0, 255, 7]);
  });

  it("stores a large upload across GridFS chunks", async () => {
    const stores = await database.reset();
    const data = new Uint8Array(600 * 1024).map((_, i) => i % 251);
    const meta = await stores.files.put({
      name: "big.bin",
      contentType: null,
      ownerId: "11111111-1111-4111-8111-111111111111",
      expiresAt: new Date(Date.now() + 60_000),
      data,
    });
    expect(meta.size).toBe(data.byteLength);
    const found = await stores.files.get(meta.id);
    expect(found?.data).toEqual(data);
    expect(found?.meta).toEqual(meta);
  });

  it("streams a large upload in and out, and drops the chunks of one that is too large", async () => {
    const stores = await database.reset();
    const chunk = new Uint8Array(100 * 1024).fill(7);
    const chunks = async function* (count: number) {
      for (let i = 0; i < count; i++) yield chunk;
    };
    const fields = {
      name: "stream.bin",
      contentType: null,
      ownerId: "11111111-1111-4111-8111-111111111111",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const meta = await stores.files.putStream({ ...fields, stream: chunks(6) });
    expect(meta.size).toBe(6 * chunk.byteLength);
    const opened = await stores.files.openDownload(meta.id);
    let received = 0;
    for await (const part of opened?.stream ?? []) received += (part as Uint8Array).byteLength;
    expect(received).toBe(meta.size);

    const before = await database.db.collection("uploads.chunks").countDocuments();
    await expect(
      stores.files.putStream({ ...fields, stream: chunks(6) }, 3 * chunk.byteLength),
    ).rejects.toThrow(/larger than/);
    expect(await database.db.collection("uploads.chunks").countDocuments()).toBe(before);
    expect(await database.db.collection("uploads.files").countDocuments()).toBe(1);
  });

  it("builds the additive admin index on populated collections without replacing old indexes", async () => {
    await database.reset();
    const collection = database.db.collection<{ _id: string; createdAt: Date; expiresAt: null }>(
      COLLECTIONS.shares,
    );
    await collection.dropIndex("createdAt_id_desc");
    await collection.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        _id: `legacy${i}`,
        createdAt: new Date(2026, 0, 1),
        expiresAt: null,
      })),
    );
    await ensureIndexes(database.db);
    await ensureIndexes(database.db);
    expect(await collection.countDocuments()).toBe(300);
    const indexes = await collection.indexes();
    expect(indexes.find((index) => index.name === "createdAt_id_desc")?.key).toEqual({
      createdAt: -1,
      _id: -1,
    });
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["_id_", "ownerId", "savedBy", "labId", "expiresAt_ttl"]),
    );
  });

  it("cleans multiple pages of orphan references once and preserves accessible labels", async () => {
    const stores = await database.reset();
    const now = new Date();
    const ids = Array.from({ length: 600 }, (_, i) => `gone${String(i).padStart(4, "0")}`);
    await database.db
      .collection(COLLECTIONS.updates)
      .insertMany(
        ids.flatMap((shareId) =>
          [1, 2].map((seq) => ({ shareId, seq, data: new Binary(new Uint8Array([1])), at: now })),
        ),
      );
    await database.db.collection(COLLECTIONS.snapshots).insertMany(
      ids.map((shareId) => ({
        shareId,
        seq: 1,
        kind: "compact",
        at: now,
        state: new Binary(new Uint8Array([1])),
      })),
    );
    await database.db
      .collection<{ _id: string; ownerId: string; savedBy: string[] }>(COLLECTIONS.shares)
      .insertOne({ _id: "live0001", ownerId: "owner", savedBy: ["saver"] });
    await database.db
      .collection<{
        _id: string;
        clientId: string;
        shareId: string;
        folder: null;
        tags: string[];
        updatedAt: Date;
      }>(COLLECTIONS.labels)
      .insertMany([
        ...ids.map((shareId) => ({
          _id: `owner:${shareId}`,
          clientId: "owner",
          shareId,
          folder: null,
          tags: [],
          updatedAt: now,
        })),
        ...["owner", "saver", "stranger"].map((clientId) => ({
          _id: `${clientId}:live0001`,
          clientId,
          shareId: "live0001",
          folder: null,
          tags: [],
          updatedAt: now,
        })),
        {
          _id: "owner:labelOnly",
          clientId: "owner",
          shareId: "labelOnly",
          folder: null,
          tags: [],
          updatedAt: now,
        },
      ]);
    await stores.files.put({
      name: "a",
      contentType: null,
      ownerId: "owner",
      shareId: "fileOnly",
      expiresAt: new Date(Date.now() + 60000),
      data: new Uint8Array([1, 2, 3]),
    });
    const renew = vi.fn(async () => {});
    expect(await stores.maintenance?.sweep(now, renew)).toEqual({ orphans: 602 });
    expect(renew.mock.calls.length).toBeGreaterThan(5);
    expect(await stores.updates.shareIds()).toEqual([]);
    expect(await stores.snapshots.shareIds()).toEqual([]);
    expect(await stores.files.shareIds()).toEqual([]);
    expect(await stores.labels.get("stranger", "live0001")).toBeNull();
    expect(await stores.labels.get("owner", "live0001")).not.toBeNull();
    expect(await stores.labels.get("saver", "live0001")).not.toBeNull();
    expect(await stores.maintenance?.sweep(now, renew)).toEqual({ orphans: 0 });
    expect(
      (
        await database.db
          .collection<{ _id: string; bytes: number }>("storage_quotas")
          .findOne({ _id: "uploads" })
      )?.bytes,
    ).toBe(0);
  });

  it("batches GridFS cleanup and charges concurrent deletes only once", async () => {
    const stores = await database.reset();
    const now = new Date();
    const files = Array.from({ length: 301 }, (_, i) => ({
      _id: new ObjectId(),
      length: 4,
      chunkSize: 261120,
      uploadDate: now,
      filename: "fixture",
      metadata: {
        ownerId: "owner",
        shareId: i === 300 ? "live" : "expired",
        expiresAt: new Date(now.getTime() + (i === 300 ? 60000 : -60000)),
        contentType: null,
      },
    }));
    await database.db.collection("uploads.files").insertMany(files);
    await database.db.collection("uploads.chunks").insertMany(
      files.map((file) => ({
        files_id: file._id,
        n: 0,
        data: new Binary(new Uint8Array([1, 2, 3, 4])),
      })),
    );
    await Promise.all([stores.files.deleteExpired(now), stores.files.deleteForShare("expired")]);
    expect(await database.db.collection("uploads.files").countDocuments()).toBe(1);
    expect(await database.db.collection("uploads.chunks").countDocuments()).toBe(1);
    expect(
      (
        await database.db
          .collection<{ _id: string; bytes: number }>("storage_quotas")
          .findOne({ _id: "uploads" })
      )?.bytes,
    ).toBe(4);
    await expect(
      stores.files.putStream(
        {
          name: "over-capacity",
          ownerId: "owner",
          contentType: null,
          expiresAt: new Date(now.getTime() + 60000),
          stream: (async function* () {
            yield new Uint8Array([1]);
          })(),
        },
        undefined,
        4,
      ),
    ).rejects.toThrow("capacity");
    expect(await database.db.collection("uploads.chunks").countDocuments()).toBe(1);
  });

  it("renews bounded expiry/retention passes and preserves a share touched after selection", async () => {
    const stores = await database.reset();
    // A synthetic sweep time keeps the real TTL monitor out of this ordering test.
    const now = new Date(Date.now() + 3600000);
    const later = new Date(now.getTime() + 3600000);
    const shares = database.db.collection<{ _id: string; expiresAt: Date }>(COLLECTIONS.shares);
    await shares.insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        _id: `expire${String(i).padStart(4, "0")}`,
        expiresAt: new Date(now.getTime() - 1000),
      })),
    );
    const old = new Date(now.getTime() - 366 * 86400000);
    await database.db.collection(COLLECTIONS.snapshots).insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        shareId: "retained",
        seq: i,
        kind: "history",
        at: old,
        state: new Binary(new Uint8Array([1])),
      })),
    );
    await shares.insertOne({ _id: "retained", expiresAt: later });
    await database.db
      .collection(COLLECTIONS.audit)
      .insertMany(Array.from({ length: 300 }, () => ({ at: old })));
    let renewals = 0;
    await stores.maintenance?.sweep(now, async () => {
      renewals++;
      if (renewals === 1)
        await shares.updateOne({ _id: "expire0299" }, { $set: { expiresAt: later } });
    });
    expect(renewals).toBeGreaterThan(5);
    expect(await shares.findOne({ _id: "expire0299" })).not.toBeNull();
    expect(await shares.countDocuments()).toBe(2);
    expect(await database.db.collection(COLLECTIONS.snapshots).countDocuments()).toBe(0);
    expect(await database.db.collection(COLLECTIONS.audit).countDocuments()).toBe(0);
  });

  it("preserves labels replaced after a cleanup page was read", async () => {
    const stores = await database.reset();
    await database.db
      .collection<{ _id: string; ownerId: string; savedBy: string[] }>(COLLECTIONS.shares)
      .insertOne({ _id: "live0001", ownerId: "owner", savedBy: [] });
    await stores.labels.set("stranger", "live0001", { folder: "old", tags: [] }, new Date());
    const original = Collection.prototype.deleteMany;
    const remove = vi.spyOn(Collection.prototype, "deleteMany").mockImplementation(async function (
      this: Collection,
      filter,
      options,
    ) {
      if (
        this.dbName === database.db.databaseName &&
        this.collectionName === COLLECTIONS.labels &&
        filter?.$or
      ) {
        await stores.labels.set(
          "stranger",
          "live0001",
          { folder: "new", tags: ["new"] },
          new Date(),
        );
      }
      return original.call(this, filter, options);
    });
    try {
      await stores.maintenance?.sweep(new Date(), async () => {});
      expect(await stores.labels.get("stranger", "live0001")).toMatchObject({
        folder: "new",
        tags: ["new"],
      });
    } finally {
      remove.mockRestore();
    }
  });
});
