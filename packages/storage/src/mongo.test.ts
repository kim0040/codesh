import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      expect.arrayContaining(["ownerId", "savedBy", "labId"]),
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
});
