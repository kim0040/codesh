import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeContract } from "./contract.js";
import type { SqlDriver } from "./sql/driver.js";
import { openSqlDriver } from "./sql/driver.js";
import { ensureSqlSchema, resetSqlTables } from "./sql/schema.js";
import { createSqlStores } from "./sql/stores.js";
import { requireService } from "./testing.js";
import type { Stores } from "./types.js";
import { DuplicateSeqError, StorageCapacityError } from "./types.js";

interface Fixture {
  driver: SqlDriver;
  stores: Stores;
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function fixture(url: string): Promise<Fixture> {
  const driver = await openSqlDriver(url);
  try {
    await ensureSqlSchema(driver);
    return {
      driver,
      stores: createSqlStores(driver),
      reset: () => resetSqlTables(driver),
      close: () => driver.close(),
    };
  } catch (error) {
    await driver.close();
    throw error;
  }
}

function sampleShare(id: string) {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    title: "SQL concurrency",
    language: "typescript",
    ownerId: "11111111-1111-4111-8111-111111111111",
    createdAt: at,
    updatedAt: at,
    lastActiveAt: at,
    expiresAt: new Date(at.getTime() + 86_400_000),
    saved: false,
    savedBy: [],
    access: {
      default: "edit" as const,
      editKey: "key",
      pinHash: null,
      requireApproval: false,
      nearby: true,
    },
    bans: [],
    joinCode: "123456",
    locked: false,
    sizeBytes: 0,
  };
}

const id = () => randomBytes(5).toString("hex");

async function checkConcurrentWrites(first: Stores, second: Stores) {
  const shareId = id();
  await first.shares.create(sampleShare(shareId));
  await Promise.all([
    first.shares.update(shareId, { access: { requireApproval: true } }),
    second.shares.update(shareId, { access: { allowParticipantFiles: true } }),
  ]);
  expect(await first.shares.get(shareId)).toMatchObject({
    access: { requireApproval: true, allowParticipantFiles: true },
  });

  const savedId = id();
  await first.shares.create(sampleShare(savedId));
  await Promise.all([
    first.shares.touch(savedId, new Date(), new Date(Date.now() + 60_000)),
    second.shares.addSaved(savedId, "22222222-2222-4222-8222-222222222222"),
  ]);
  expect(await first.shares.get(savedId)).toMatchObject({ saved: true, expiresAt: null });

  const updateShareId = id();
  const results = await Promise.allSettled([
    first.updates.append(updateShareId, [{ seq: 7, data: new Uint8Array([7]) }], new Date()),
    second.updates.append(updateShareId, [{ seq: 7, data: new Uint8Array([8]) }], new Date()),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DuplicateSeqError);
  expect(await first.updates.read(updateShareId, 0)).toHaveLength(1);

  const capacityInput = (name: string) => ({
    name,
    ownerId: "11111111-1111-4111-8111-111111111111",
    expiresAt: new Date(Date.now() + 60_000),
    contentType: null,
    stream: (async function* () {
      yield new Uint8Array(6);
    })(),
  });
  const uploads = await Promise.allSettled([
    first.files.putStream(capacityInput("first.bin"), 100, 10),
    second.files.putStream(capacityInput("second.bin"), 100, 10),
  ]);
  expect(uploads.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const refusedUpload = uploads.find((result) => result.status === "rejected");
  expect(refusedUpload?.status === "rejected" && refusedUpload.reason).toBeInstanceOf(
    StorageCapacityError,
  );

  const labId = id();
  await first.labs.create({
    id: labId,
    title: "Concurrent lab",
    ownerId: "11111111-1111-4111-8111-111111111111",
    joinCode: "654321",
    templateShareId: null,
    locked: false,
    students: [],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await Promise.all([
    first.labs.addStudent(labId, {
      clientId: "11111111-1111-4111-8111-111111111111",
      name: "One",
      shareId: id(),
      joinedAt: new Date(),
    }),
    second.labs.addStudent(labId, {
      clientId: "22222222-2222-4222-8222-222222222222",
      name: "Two",
      shareId: id(),
      joinedAt: new Date(),
    }),
  ]);
  expect((await first.labs.get(labId))?.students).toHaveLength(2);
}

async function checkExpiredShareCascade(stores: Stores) {
  const shareId = id();
  const ownerId = "11111111-1111-4111-8111-111111111111";
  await stores.shares.create({ ...sampleShare(shareId), expiresAt: new Date(Date.now() - 1000) });
  await stores.updates.append(shareId, [{ seq: 1, data: new Uint8Array([1]) }], new Date());
  await stores.snapshots.put({
    shareId,
    kind: "history",
    seq: 1,
    at: new Date(),
    state: new Uint8Array([2]),
  });
  await stores.files.put({
    name: "cascade.bin",
    contentType: null,
    ownerId,
    shareId,
    expiresAt: new Date(Date.now() + 60_000),
    data: new Uint8Array([3, 4]),
  });
  await stores.labels.set(ownerId, shareId, { folder: "saved", tags: ["x"] }, new Date());

  expect(await stores.shares.deleteExpired(new Date())).toEqual([shareId]);
  expect(await stores.updates.read(shareId, 0)).toEqual([]);
  expect(await stores.snapshots.latest(shareId, "history")).toBeNull();
  expect(await stores.files.shareIds()).toEqual([]);
  expect(await stores.labels.get(ownerId, shareId)).toBeNull();
  const replacement = await stores.files.putStream(
    {
      name: "replacement.bin",
      contentType: null,
      ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      stream: (async function* () {
        yield new Uint8Array([5, 6]);
      })(),
    },
    undefined,
    2,
  );
  expect(replacement.size).toBe(2);
}

async function checkConcurrentMigrations(first: Fixture, second: Fixture) {
  await first.driver.run("DELETE FROM schema_version");
  await Promise.all([ensureSqlSchema(first.driver), ensureSqlSchema(second.driver)]);
  const versions = await first.driver.all<{ version: number | string }>(
    "SELECT version FROM schema_version",
  );
  expect(versions.map((row) => Number(row.version))).toEqual([1]);
}

describe("SQLite stores", () => {
  let directory: string;
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "gachipad-sqlite-"));
  });
  afterAll(async () => {
    await Promise.all(fixtures.map((item) => item.close()));
    await rm(directory, { recursive: true, force: true });
  });

  for (const [name, url] of [
    ["file", () => `sqlite://${join(directory, "contract.db")}`],
    ["memory", () => "sqlite::memory:"],
  ] as const) {
    describe(name, () => {
      let db: Fixture;
      beforeAll(async () => {
        db = await fixture(url());
        fixtures.push(db);
      });
      storeContract("storeContract", async () => {
        await db.reset();
        return db.stores;
      });
      it("removes expired share content and returns upload capacity", async () => {
        await db.reset();
        await checkExpiredShareCascade(db.stores);
      });
      if (name === "file")
        it("is safe for two connections and migrates concurrently", async () => {
          await db.reset();
          const urlValue = url();
          const [firstOpen, secondOpen] = await Promise.all([fixture(urlValue), fixture(urlValue)]);
          fixtures.push(firstOpen, secondOpen);
          await firstOpen.reset();
          await checkConcurrentMigrations(firstOpen, secondOpen);
          await checkConcurrentWrites(firstOpen.stores, secondOpen.stores);
        });
    });
  }
});

const postgresUrl = process.env.TEST_POSTGRES_URL;
const mysqlUrl = process.env.TEST_MYSQL_URL;
const mariaUrl = process.env.TEST_MARIADB_URL;

async function databaseAvailable(name: string, url: string | undefined): Promise<boolean> {
  if (!url) return false;
  return requireService(name, async () => {
    const driver = await openSqlDriver(url);
    try {
      await ensureSqlSchema(driver);
    } finally {
      await driver.close();
    }
  });
}

async function externalBackend(name: string, url: string | undefined) {
  const available = await databaseAvailable(name, url);
  describe.runIf(available)(`${name} stores`, () => {
    let db: Fixture;
    let second: Fixture;
    beforeAll(async () => {
      db = await fixture(url as string);
      second = await fixture(url as string);
    });
    afterAll(async () => {
      await db?.close();
      await second?.close();
    });
    storeContract("storeContract", async () => {
      await db.reset();
      return db.stores;
    });
    it("removes expired share content and returns upload capacity", async () => {
      await db.reset();
      await checkExpiredShareCascade(db.stores);
    });
    it("preserves atomic operations across two connections", async () => {
      await db.reset();
      await checkConcurrentWrites(db.stores, second.stores);
    });
    it("runs migrations safely from two connections", async () => {
      await db.reset();
      await checkConcurrentMigrations(db, second);
    });
  });
}

await externalBackend("PostgreSQL", postgresUrl);
await externalBackend("MySQL", mysqlUrl);
await externalBackend("MariaDB", mariaUrl);
