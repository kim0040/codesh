import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { storeContract } from "./contract.js";
import type { SqlDriver, SqlExecutor, SqlRow } from "./sql/driver.js";
import { openSqlDriver } from "./sql/driver.js";
import { ensureSqlSchema, resetSqlTables } from "./sql/schema.js";
import { createSqlStores } from "./sql/stores.js";
import { requireService } from "./testing.js";
import type { Stores } from "./types.js";
import { DuplicateSeqError, FileTooLargeError, StorageCapacityError } from "./types.js";

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
  const at = new Date();
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observe(
  driver: SqlDriver,
  after: (sql: string, values: unknown[], rows?: SqlRow[]) => void | Promise<void>,
): SqlDriver {
  const wrap = (executor: SqlExecutor): SqlExecutor => ({
    async all<Row extends SqlRow>(sql: string, values: unknown[] = []) {
      const rows = await executor.all<Row>(sql, values);
      await after(sql, values, rows);
      return rows;
    },
    async run(sql, values = []) {
      const count = await executor.run(sql, values);
      await after(sql, values);
      return count;
    },
  });
  return {
    ...driver,
    ...wrap(driver),
    transaction: (work) => driver.transaction((tx) => work(wrap(tx))),
  };
}

const upload = (shareId?: string, data = new Uint8Array([1, 2, 3, 4, 5])) => ({
  name: "regression.bin",
  ownerId: "11111111-1111-4111-8111-111111111111",
  contentType: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  ...(shareId ? { shareId } : {}),
  data,
});

async function usedBytes(db: Fixture) {
  const [row] = await db.driver.all<{ used_bytes: number | string }>(
    "SELECT used_bytes FROM upload_capacity WHERE id=1",
  );
  return Number(row?.used_bytes);
}

function sqlRegressions(open: () => Fixture, other: () => Fixture) {
  describe("review regressions", () => {
    beforeEach(async () => {
      await open().reset();
    });

    for (const action of ["save", "renew"] as const) {
      it(`revalidates an expiry candidate after a concurrent ${action}`, async () => {
        const db = open();
        const share = sampleShare(id());
        const cutoff = new Date(share.expiresAt.getTime() + 1);
        await db.stores.shares.create(share);
        await db.stores.updates.append(
          share.id,
          [{ seq: 1, data: new Uint8Array([1]) }],
          new Date(),
        );
        let changed = false;
        const stores = createSqlStores(
          observe(db.driver, async (sql) => {
            if (!changed && sql.startsWith("SELECT id FROM shares WHERE expires_at")) {
              changed = true;
              if (action === "save") await other().stores.shares.addSaved(share.id, "saver");
              else
                await other().stores.shares.touch(
                  share.id,
                  new Date(),
                  new Date(cutoff.getTime() + 60_000),
                );
            }
          }),
        );
        expect(await stores.shares.deleteExpired(cutoff)).toEqual([]);
        expect(changed).toBe(true);
        expect(await db.stores.shares.get(share.id)).not.toBeNull();
        expect(await db.stores.updates.read(share.id, 0)).toHaveLength(1);
      });
    }

    for (const action of ["delete", "upload"] as const) {
      it(`uses current quota rows after a concurrent ${action} under repeatable read`, async () => {
        const db = open();
        const share = sampleShare(id());
        await db.stores.shares.create(share);
        const file = action === "delete" ? await db.stores.files.put(upload(share.id)) : null;
        let changed = false;
        const change = async () => {
          if (file) await other().stores.files.delete(file.id);
          else await other().stores.files.put(upload(share.id));
        };
        if (db.driver.dialect === "sqlite") {
          await Promise.all([db.stores.shares.delete(share.id), change()]);
          await db.stores.files.deleteForShare(share.id);
        } else {
          const stores = createSqlStores(
            observe(db.driver, async (sql) => {
              if (!changed && /^SELECT id FROM shares WHERE id ?= ?\?/.test(sql)) {
                changed = true;
                await change();
              }
            }),
          );
          await stores.shares.delete(share.id);
          expect(changed).toBe(true);
        }
        expect(await usedBytes(db)).toBe(0);
        expect(await db.stores.files.shareIds()).toEqual([]);
        const replacement = await db.stores.files.putStream(
          {
            ...upload(),
            stream: (async function* () {
              yield new Uint8Array(5);
            })(),
          },
          5,
          5,
        );
        expect(replacement.size).toBe(5);
        await expect(
          db.stores.files.putStream(
            {
              ...upload(),
              stream: (async function* () {
                yield new Uint8Array(1);
              })(),
            },
            5,
            5,
          ),
        ).rejects.toBeInstanceOf(StorageCapacityError);
      });
    }

    it("keeps mixed-case share, client and lab identifiers distinct", async () => {
      const { stores } = open();
      const upper = { ...sampleShare("AbCd1234"), ownerId: "Owner", labId: "LabA" };
      const lower = { ...sampleShare("abcd1234"), ownerId: "owner", labId: "laba" };
      await stores.shares.create(upper);
      expect(await stores.shares.get(lower.id)).toBeNull();
      await stores.shares.create(lower);
      await stores.shares.addSaved(upper.id, "Saver");
      await stores.shares.addSaved(upper.id, "saver");
      await stores.shares.addBan(upper.id, "Banned");
      await stores.shares.addBan(upper.id, "banned");
      expect(await stores.shares.get(upper.id)).toMatchObject({
        savedBy: ["Saver", "saver"],
        bans: ["Banned", "banned"],
      });
      expect((await stores.shares.listForClient("owner")).map((s) => s.id)).toEqual([lower.id]);
      expect((await stores.shares.listByLab("laba")).map((s) => s.id)).toEqual([lower.id]);
      for (const share of [upper, lower]) {
        await stores.updates.append(share.id, [{ seq: 1, data: new Uint8Array([1]) }], new Date());
        await stores.snapshots.put({
          shareId: share.id,
          kind: "history",
          seq: 1,
          state: new Uint8Array([1]),
          at: new Date(),
        });
        await stores.labels.set("Client", share.id, { folder: share.id, tags: [] }, new Date());
        await stores.labs.create({
          id: share.labId,
          title: "Case",
          ownerId: share.ownerId,
          joinCode: "654321",
          templateShareId: share.id,
          locked: false,
          students: [],
          createdAt: new Date(),
          expiresAt: share.expiresAt,
        });
      }
      await stores.shares.delete(upper.id);
      expect(await stores.shares.get(lower.id)).not.toBeNull();
      expect(await stores.updates.read(lower.id, 0)).toHaveLength(1);
      expect(await stores.snapshots.latest(lower.id, "history")).not.toBeNull();
      expect(await stores.labels.get("Client", lower.id)).not.toBeNull();
      expect(await stores.labels.get("client", lower.id)).toBeNull();
      expect(await stores.labs.get("LABA")).toBeNull();
      expect(await stores.labs.get("laba")).toMatchObject({ id: "laba" });
    });

    it("paginates equal-time mixed-case identifiers in binary order", async () => {
      const { shares } = open().stores;
      const at = new Date();
      for (const value of ["Aaaa1234", "aaaa1234", "Zzzz1234", "zzzz1234"])
        await shares.create({ ...sampleShare(value), createdAt: at });
      expect((await shares.adminList("")).map((s) => s.id)).toEqual([
        "zzzz1234",
        "aaaa1234",
        "Zzzz1234",
        "Aaaa1234",
      ]);
      expect((await shares.adminList("", at, "aaaa1234")).map((s) => s.id)).toEqual([
        "Zzzz1234",
        "Aaaa1234",
      ]);
    });

    it("does not hold a write transaction while awaiting an upload body", async () => {
      const db = open();
      const share = sampleShare(id());
      await db.stores.shares.create(share);
      const waiting = deferred();
      const release = deferred();
      const writing = db.stores.files.putStream({
        ...upload(),
        stream: (async function* () {
          yield new Uint8Array(256 * 1024);
          waiting.resolve();
          await release.promise;
          yield new Uint8Array([7]);
        })(),
      });
      await waiting.promise;
      try {
        expect(
          await Promise.race([
            other().stores.shares.touch(share.id, new Date(), share.expiresAt),
            new Promise((resolve) => setTimeout(() => resolve("blocked"), 1500)),
          ]),
        ).toBe(true);
        const [row] = await db.driver.all<{ id: string }>("SELECT id FROM uploads");
        expect(await db.stores.files.meta(row?.id ?? "")).toBeNull();
        expect(await usedBytes(db)).toBe(256 * 1024);
      } finally {
        release.resolve();
        await writing;
      }
    });

    it.each(["abort", "size", "capacity"])(
      "releases staged chunks and quota on %s failure",
      async (reason) => {
        const db = open();
        let consumed = 0;
        const stream = (async function* () {
          consumed++;
          yield new Uint8Array(256 * 1024);
          if (reason === "abort") throw new Error("request aborted");
          consumed++;
          yield new Uint8Array(256 * 1024);
        })();
        await expect(
          db.stores.files.putStream(
            { ...upload(), stream },
            reason === "size" ? 256 * 1024 : undefined,
            reason === "capacity" ? 256 * 1024 : undefined,
          ),
        ).rejects.toBeInstanceOf(
          reason === "size"
            ? FileTooLargeError
            : reason === "capacity"
              ? StorageCapacityError
              : Error,
        );
        expect(consumed).toBe(reason === "abort" ? 1 : 2);
        expect(await usedBytes(db)).toBe(0);
        expect(await db.driver.all("SELECT id FROM uploads")).toEqual([]);
        expect(await db.driver.all("SELECT upload_id FROM upload_chunks")).toEqual([]);
      },
    );

    it("removes staging metadata when constructing or cancelling an iterator throws", async () => {
      const db = open();
      for (const construct of [true, false]) {
        const stream: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]() {
            if (construct) throw new Error("iterator unavailable");
            return {
              async next() {
                throw new Error("request aborted");
              },
              return() {
                throw new Error("cancellation failed");
              },
            };
          },
        };
        await expect(db.stores.files.putStream({ ...upload(), stream })).rejects.toThrow(
          construct ? "iterator unavailable" : "request aborted",
        );
        expect(await usedBytes(db)).toBe(0);
        expect(await db.driver.all("SELECT id FROM uploads")).toEqual([]);
      }
    });

    it("times out an idle body and cancels it without retaining reserved capacity", async () => {
      const db = open();
      const waiting = deferred();
      const release = deferred();
      const stream = (async function* () {
        yield new Uint8Array(256 * 1024);
        waiting.resolve();
        await release.promise;
      })();
      const original = globalThis.setTimeout;
      const timer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((
          handler: (...args: unknown[]) => void,
          timeout?: number,
          ...args: unknown[]
        ) =>
          original(
            () => handler(...args),
            timeout === 60_000 ? 50 : timeout,
          )) as typeof setTimeout);
      const writing = db.stores.files.putStream({ ...upload(), stream });
      const failed = expect(writing).rejects.toThrow("Upload idle timeout");
      try {
        await waiting.promise;
        await failed;
        expect(await usedBytes(db)).toBe(0);
        expect(await db.driver.all("SELECT id FROM uploads")).toEqual([]);
      } finally {
        timer.mockRestore();
        release.resolve();
      }
    });

    it("reclaims incomplete uploads after a crash but preserves active leases", async () => {
      const db = open();
      const file = await db.stores.files.put(upload());
      const live = await db.stores.files.put(upload());
      await db.driver.run("UPDATE uploads SET complete=FALSE,lease_until=? WHERE id=?", [
        Date.now() - 1,
        file.id,
      ]);
      await db.driver.run("UPDATE uploads SET complete=FALSE,lease_until=? WHERE id=?", [
        Date.now() + 60_000,
        live.id,
      ]);
      expect(await db.stores.files.meta(file.id)).toBeNull();
      expect(await db.stores.files.deleteExpired(new Date())).toBe(1);
      expect(await usedBytes(db)).toBe(5);
      expect(
        await db.driver.all("SELECT upload_id FROM upload_chunks WHERE upload_id=?", [file.id]),
      ).toEqual([]);
      expect(await db.stores.files.delete(live.id)).toBe(true);
      expect(await usedBytes(db)).toBe(0);
    });

    it("maps overlapping reversed append batches to DuplicateSeqError", async () => {
      const shareId = id();
      const entries = [1, 2].map((seq) => ({ seq, data: new Uint8Array([seq]) }));
      const results = await Promise.allSettled([
        open().stores.updates.append(shareId, entries, new Date()),
        other().stores.updates.append(shareId, [...entries].reverse(), new Date()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DuplicateSeqError);
      expect((await open().stores.updates.read(shareId, 0)).map((e) => e.seq)).toEqual([1, 2]);
    });

    it("hides expired shares and refuses touch before the sweeper runs", async () => {
      const db = open();
      const share = { ...sampleShare(id()), labId: "lab" };
      await db.stores.shares.create(share);
      expect(await db.stores.shares.get(share.id)).not.toBeNull();
      await db.driver.run("UPDATE shares SET expires_at=? WHERE id=?", [Date.now() - 1, share.id]);
      expect(await db.stores.shares.get(share.id)).toBeNull();
      expect(await db.stores.shares.touch(share.id, new Date(), share.expiresAt)).toBe(false);
      expect(await db.stores.shares.listForClient(share.ownerId)).toEqual([]);
      expect(await db.stores.shares.listByLab("lab")).toEqual([]);
      // Physical rows remain until the locked expiry delete, so orphan cleanup cannot race a renewal.
      expect(await db.stores.shares.existing([share.id])).toEqual(new Set([share.id]));
    });

    it("ignores undefined share and access fields while preserving explicit null", async () => {
      const { shares } = open().stores;
      const share = sampleShare(id());
      await shares.create({ ...share, access: { ...share.access, pinHash: "hash" } });
      expect(
        await shares.update(share.id, {
          title: undefined,
          expiresAt: undefined,
          access: { pinHash: undefined, requireApproval: true },
        }),
      ).toMatchObject({
        title: share.title,
        expiresAt: share.expiresAt,
        access: { pinHash: "hash", requireApproval: true },
      });
      expect(
        await shares.update(share.id, { expiresAt: null, access: { pinHash: null } }),
      ).toMatchObject({ expiresAt: null, access: { pinHash: null } });
    });

    it("searches Unicode titles case-insensitively with literal substrings", async () => {
      const { shares } = open().stores;
      const share = sampleShare(id());
      await shares.create({ ...share, title: "CAFÉ ÄÖ Σ 문서 한글 %_!" });
      for (const search of ["café", "äö", "σ", "문서", "한글", "%_!"])
        expect((await shares.adminList(search)).map((s) => s.id)).toEqual([share.id]);
      expect(await shares.adminList("cafe")).toEqual([]);
      await shares.update(share.id, { title: "ÉCOLE 한국어" });
      expect((await shares.adminList("école 한국어")).map((s) => s.id)).toEqual([share.id]);
      expect(await shares.adminList("café")).toEqual([]);
    });

    it("hydrates client lists in bulk and aggregates admin activity in SQL", async () => {
      const db = open();
      const owner = sampleShare(id()).ownerId;
      for (let i = 0; i < 12; i++) {
        const share = sampleShare(id());
        await db.stores.shares.create({
          ...share,
          savedBy: ["first", "second"],
          bans: ["one", "two"],
        });
      }
      const queries: Array<{ sql: string; rows: number }> = [];
      const stores = createSqlStores(
        observe(db.driver, (sql, _values, rows) => {
          if (rows) queries.push({ sql, rows: rows.length });
        }),
      );
      const shares = await stores.shares.listForClient(owner);
      expect(shares).toHaveLength(12);
      expect(
        shares.every(
          (s) => s.savedBy.join(",") === "first,second" && s.bans.join(",") === "one,two",
        ),
      ).toBe(true);
      expect(queries).toHaveLength(3);
      queries.length = 0;
      const summary = await stores.shares.adminSummary();
      expect(summary.shares).toBe(12);
      expect(summary.activity[23]).toBe(12);
      expect(queries).toHaveLength(1);
      expect(queries[0]?.rows).toBe(1);
      expect(queries[0]?.sql).toContain("SUM(CASE");
    });

    it("cleans inaccessible labels with one set-based statement", async () => {
      const db = open();
      const share = sampleShare(id());
      await db.stores.shares.create(share);
      await db.stores.shares.addSaved(share.id, "saver");
      for (const client of [share.ownerId, "saver", "stranger"])
        await db.stores.labels.set(client, share.id, { folder: "folder", tags: [] }, new Date());
      await db.stores.labels.set("stranger", "missing", { folder: "folder", tags: [] }, new Date());
      const statements: string[] = [];
      const stores = createSqlStores(
        observe(db.driver, (sql) => {
          statements.push(sql);
        }),
      );
      expect(await stores.labels.deleteInaccessible?.()).toBe(2);
      expect(statements).toHaveLength(1);
      expect(await stores.labels.get(share.ownerId, share.id)).not.toBeNull();
      expect(await stores.labels.get("saver", share.id)).not.toBeNull();
      expect(await stores.labels.get("stranger", share.id)).toBeNull();
    });

    it("reads upload chunks in bounded batches for get and openDownload", async () => {
      const db = open();
      const data = new Uint8Array(20 * 256 * 1024 + 1).fill(37);
      const file = await db.stores.files.put(upload(undefined, data));
      let largestBatch = 0;
      let batches = 0;
      const stores = createSqlStores(
        observe(db.driver, (sql, _values, rows) => {
          if (sql.includes("FROM upload_chunks") && rows) {
            largestBatch = Math.max(largestBatch, rows.length);
            batches++;
          }
        }),
      );
      expect(
        Buffer.from((await stores.files.get(file.id))?.data ?? []).equals(Buffer.from(data)),
      ).toBe(true);
      expect(largestBatch).toBeLessThanOrEqual(8);
      expect(batches).toBeLessThanOrEqual(4);
      batches = 0;
      const download = await stores.files.openDownload(file.id);
      const chunks: Buffer[] = [];
      if (download) for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(Buffer.from(data))).toBe(true);
      expect(batches).toBeLessThanOrEqual(4);
    });
  });
}

function retryRegression(first: () => Fixture, second: () => Fixture) {
  it("bounds serialization retries and rolls back every failed attempt", async () => {
    const db = first();
    await db.reset();
    let attempts = 0;
    const failure = Object.assign(new Error("serialization failure"), {
      code: db.driver.dialect === "postgres" ? "40001" : "ER_LOCK_DEADLOCK",
    });
    await expect(
      db.driver.transaction(async (tx) => {
        attempts++;
        await tx.run("INSERT INTO settings (id,value_json) VALUES (?,?)", ["retry-rollback", "0"]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(5);
    expect(await db.driver.all("SELECT id FROM settings")).toEqual([]);
  });

  it("retries chunk SQL without replaying the consumed upload stream", async () => {
    const db = first();
    await db.reset();
    let injected = false;
    let reads = 0;
    const stores = createSqlStores(
      observe(db.driver, (sql) => {
        if (!injected && sql.startsWith("INSERT INTO upload_chunks")) {
          injected = true;
          throw Object.assign(new Error("serialization failure"), {
            code: db.driver.dialect === "postgres" ? "40001" : "ER_LOCK_DEADLOCK",
          });
        }
      }),
    );
    const file = await stores.files.putStream({
      ...upload(),
      stream: (async function* () {
        reads++;
        yield new Uint8Array(256 * 1024);
        reads++;
        yield new Uint8Array([9]);
      })(),
    });
    expect(injected).toBe(true);
    expect(reads).toBe(2);
    expect(await usedBytes(db)).toBe(256 * 1024 + 1);
    expect((await stores.files.get(file.id))?.data[256 * 1024]).toBe(9);
  });

  it("retries a whole replayable transaction after a real database deadlock", async () => {
    const db = first();
    await db.reset();
    for (const key of ["retry-a", "retry-b"])
      await db.driver.run("INSERT INTO settings (id,value_json) VALUES (?,?)", [key, "0"]);
    const a = deferred();
    const b = deferred();
    const attempts = [0, 0];
    const work = (
      driver: SqlDriver,
      index: number,
      keys: string[],
      ready: ReturnType<typeof deferred>,
      peer: ReturnType<typeof deferred>,
    ) =>
      driver.transaction(async (tx) => {
        attempts[index] = (attempts[index] ?? 0) + 1;
        await tx.run("UPDATE settings SET value_json=? WHERE id=?", ["1", keys[0]]);
        if (attempts[index] === 1) {
          ready.resolve();
          await peer.promise;
        }
        await tx.run("UPDATE settings SET value_json=? WHERE id=?", ["1", keys[1]]);
      });
    await Promise.all([
      work(db.driver, 0, ["retry-a", "retry-b"], a, b),
      work(second().driver, 1, ["retry-b", "retry-a"], b, a),
    ]);
    expect((attempts[0] ?? 0) + (attempts[1] ?? 0)).toBeGreaterThan(2);
    expect(
      await db.driver.all("SELECT value_json FROM settings WHERE id IN (?,?)", [
        "retry-a",
        "retry-b",
      ]),
    ).toEqual([{ value_json: "1" }, { value_json: "1" }]);
  });
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
      let second: Fixture;
      beforeAll(async () => {
        second = name === "file" ? await fixture(url()) : db;
        if (second !== db) fixtures.push(second);
      });
      sqlRegressions(
        () => db,
        () => second,
      );
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
    sqlRegressions(
      () => db,
      () => second,
    );
    retryRegression(
      () => db,
      () => second,
    );
    it("runs migrations safely from two connections", async () => {
      await db.reset();
      await checkConcurrentMigrations(db, second);
    });
  });
}

await externalBackend("PostgreSQL", postgresUrl);
await externalBackend("MySQL", mysqlUrl);
await externalBackend("MariaDB", mariaUrl);
