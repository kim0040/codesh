import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AuditRecord, defaultSettings, type ShareRecord } from "@gachipad/shared";
import { type MongoClient, Timestamp } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "../memory.js";
import { type OpenedStores, openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import {
  CLOSE_TIMEOUT_MS,
  CopyDeadlineError,
  CopyFailureError,
  CopyRefusedError,
  CopyVerificationError,
  copyDatabase,
  type MongoIdentity,
  PG_QUERY_TIMEOUT_MS,
  sameMongoDatabase,
} from "./copy.js";
import { registerTransferBackend, transferBackend } from "./registry.js";
import { createSqlTransferBackend } from "./sql.js";
import { OPERATION_TIMEOUT_MS } from "./timeout.js";
import type { TransferBackend, TransferItem } from "./types.js";

const shareId = "Share001";
const ownerId = "11111111-1111-4111-8111-111111111111";
const savedClientId = "22222222-2222-4222-8222-222222222222";
const bannedClientId = "33333333-3333-4333-8333-333333333333";
const labelClientId = "44444444-4444-4444-8444-444444444444";

function sampleShare(): ShareRecord {
  const now = new Date("2026-10-20T08:09:10.123Z");
  return {
    id: shareId,
    title: "안녕하세요 — Copy 你好",
    language: "typescript",
    ownerId,
    createdAt: now,
    updatedAt: new Date(now.getTime() + 1000),
    lastActiveAt: new Date(now.getTime() + 2000),
    expiresAt: null,
    saved: true,
    savedBy: [savedClientId],
    access: {
      default: "edit",
      editKey: "preserved-test-value",
      generation: "generation-3",
      pinHash: null,
      requireApproval: true,
      nearby: false,
      allowParticipantRename: true,
      allowParticipantFiles: true,
      allowParticipantLanguage: false,
    },
    bans: [bannedClientId],
    joinCode: "123456",
    labId: "Lab00001",
    forkOf: "Fork0001",
    locked: true,
    sizeBytes: 256,
    preview: "Unicode preview — 한글",
    previewAt: new Date(now.getTime() + 3000),
  };
}

async function seed(stores: ReturnType<typeof createMemoryStores>) {
  const share = sampleShare();
  await stores.shares.create(share);
  await stores.shares.create({
    ...share,
    id: "Expire01",
    title: "expired but not swept",
    saved: false,
    savedBy: [],
    expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  const updateAt = new Date("2026-10-21T10:11:12.456Z");
  const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
  await stores.updates.append(share.id, [{ seq: 7, data: binary }], updateAt);
  // Garbage the TTL index or sweeper removes: children of an expired or a missing share.
  for (const garbageShare of ["Expire01", "Missing1"]) {
    await stores.updates.append(garbageShare, [{ seq: 1, data: binary }], updateAt);
    await stores.snapshots.put({
      shareId: garbageShare,
      seq: 1,
      at: updateAt,
      kind: "compact",
      state: binary,
    });
    await stores.labels.set(labelClientId, garbageShare, { folder: null, tags: ["x"] }, updateAt);
    await stores.files.put({
      name: `${garbageShare}.txt`,
      contentType: null,
      ownerId,
      shareId: garbageShare,
      expiresAt: new Date("2027-01-02T03:04:05.678Z"),
      data: binary,
    });
  }
  await stores.files.put({
    name: "expired.txt",
    contentType: null,
    ownerId,
    expiresAt: new Date("2020-01-02T03:04:05.678Z"),
    data: binary,
  });
  for (const [seq, kind] of [
    [7, "compact"],
    [8, "history"],
  ] as const) {
    await stores.snapshots.put({
      shareId,
      seq,
      at: new Date(updateAt.getTime() + seq),
      kind,
      state: binary,
    });
  }

  const uploadSize = 3 * 1024 * 1024 + 37;
  const upload = await stores.files.putStream({
    name: "sample.bin",
    contentType: "application/octet-stream",
    ownerId,
    shareId,
    expiresAt: new Date("2027-01-02T03:04:05.678Z"),
    stream: (async function* () {
      for (let offset = 0; offset < uploadSize; offset += 257 * 1024) {
        const length = Math.min(257 * 1024, uploadSize - offset);
        // Bytes that do not repeat with the 256 KiB chunk size of the SQL backends.
        yield Uint8Array.from(
          { length },
          (_, index) => Math.imul(offset + index, 2654435761) >>> 24,
        );
      }
    })(),
  });

  await stores.labs.create({
    id: "Lab00001",
    title: "자료실 — 漢字",
    ownerId,
    joinCode: "654321",
    templateShareId: shareId,
    locked: false,
    students: [
      {
        clientId: savedClientId,
        name: "학생 한 명",
        shareId: "Stud0001",
        joinedAt: new Date("2026-10-19T12:13:14.015Z"),
      },
    ],
    createdAt: new Date("2026-10-18T11:12:13.014Z"),
    expiresAt: new Date("2027-10-18T11:12:13.014Z"),
  });
  await stores.labs.create({
    id: "LabOld01",
    title: "expired lab",
    ownerId,
    joinCode: "111111",
    templateShareId: null,
    locked: false,
    students: [],
    createdAt: new Date("2019-10-18T11:12:13.014Z"),
    expiresAt: new Date("2020-10-18T11:12:13.014Z"),
  });
  await stores.labels.set(
    labelClientId,
    shareId,
    { folder: "수업 / A", tags: ["문서", "共有"] },
    new Date("2026-10-22T09:08:07.006Z"),
  );
  await stores.settings.put({
    ...defaultSettings(),
    guestAllowed: false,
    contact: "ops@example.invalid",
  });
  const audit: AuditRecord = {
    at: new Date("2026-10-23T06:05:04.003Z"),
    actor: ownerId,
    ip: "192.0.2.3",
    action: "share.saved",
    shareId,
    detail: { label: "保存しました", nested: { value: 3 } },
  };
  await stores.audit.append(audit);
  return { share, updateAt, binary, upload, uploadSize, audit };
}

function openPair(
  source: ReturnType<typeof createMemoryStores>,
  destination: ReturnType<typeof createMemoryStores>,
) {
  return async (url: string) => ({
    stores: url === "memory:" ? source : destination,
    close: async () => undefined,
    kind: "memory" as const,
  });
}

/** Memory source for "memory:", anything else through the real opener. */
function openWithMemorySource(source: ReturnType<typeof createMemoryStores>) {
  return async (url: string): Promise<OpenedStores> =>
    url === "memory:"
      ? { stores: source, close: async () => undefined, kind: "memory" }
      : openStores(url);
}

/** Replaces the transfer backend's export, keeping its other operations. */
function wrapExport(
  stores: ReturnType<typeof createMemoryStores>,
  exportAll: (actual: TransferBackend, cutoff: Date, call: number) => AsyncIterable<TransferItem>,
) {
  const actual = transferBackend(stores);
  let calls = 0;
  registerTransferBackend(stores, {
    ...actual,
    exportAll: (cutoff) => exportAll(actual, cutoff, ++calls),
  });
}

/** Replaces some transfer backend operations, keeping the others. */
function wrapTransfer(
  stores: ReturnType<typeof createMemoryStores>,
  wrap: (actual: TransferBackend) => Partial<TransferBackend>,
) {
  const actual = transferBackend(stores);
  registerTransferBackend(stores, { ...actual, ...wrap(actual) });
}

const MINUTE = 60_000;
const MARGIN = 15 * MINUTE;
const DEADLINE = 10 * MINUTE;

/** A MongoDB client whose only use is the copy's hello command; a set member is caught up. */
function helloClient(reply: Record<string, unknown>, database = "gp"): MongoClient {
  const opTime = { ts: new Timestamp({ t: 1_800_000_000, i: 1 }), t: 1 };
  return {
    db: () => ({
      databaseName: database,
      command: async () => ({
        localTime: new Date(),
        isWritablePrimary: true,
        lastWrite: { opTime, majorityOpTime: opTime },
        ...reply,
      }),
    }),
  } as unknown as MongoClient;
}

/** A MongoDB client answering hello with each reply in turn, then with the last one again. */
function helloSequence(replies: readonly Record<string, unknown>[]) {
  let calls = 0;
  const client = {
    db: () => ({
      databaseName: "gp",
      command: async () => ({
        localTime: new Date(),
        isWritablePrimary: true,
        ...replies[Math.min(calls++, replies.length - 1)],
      }),
    }),
  } as unknown as MongoClient;
  return { client, calls: () => calls };
}

/** Memory stores per URL, with an optional MongoDB client to answer hello. */
function openMemory(
  stores: Record<string, ReturnType<typeof createMemoryStores>>,
  clients: Record<string, MongoClient> = {},
) {
  return async (url: string): Promise<OpenedStores> => {
    const opened = stores[url];
    if (!opened) throw new Error("unexpected URL");
    const mongoClient = clients[url];
    return {
      stores: opened,
      close: async () => undefined,
      kind: "memory",
      ...(mongoClient ? { mongoClient } : {}),
    };
  };
}

/** Moves the monotonic clock, and optionally the wall clock, by the returned offsets. */
function fakeClocks() {
  const clocks = { monotonic: 0, wall: 0 };
  const now = performance.now.bind(performance);
  const wall = Date.now.bind(Date);
  vi.spyOn(performance, "now").mockImplementation(() => now() + clocks.monotonic);
  vi.spyOn(Date, "now").mockImplementation(() => wall() + clocks.wall);
  return clocks;
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-unit-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function capacityRows(url: string) {
  const driver = await openSqlDriver(url);
  try {
    return (
      await driver.all<{ id: number; used_bytes: number }>(
        "SELECT id,used_bytes FROM upload_capacity ORDER BY id",
      )
    ).map((row) => ({ id: Number(row.id), used_bytes: Number(row.used_bytes) }));
  } finally {
    await driver.close();
  }
}

async function sqlRun(url: string, sql: string): Promise<void> {
  const driver = await openSqlDriver(url);
  try {
    await driver.run(sql);
  } finally {
    await driver.close();
  }
}

async function sqlAll(url: string, sql: string) {
  const driver = await openSqlDriver(url);
  try {
    return await driver.all(sql);
  } finally {
    await driver.close();
  }
}

/**
 * A PostgreSQL server that accepts every connection and then never answers a query, like one
 * whose replies stopped arriving while its connections stay open.
 */
async function stalledPostgres() {
  const sockets = new Set<Socket>();
  let queries = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    let started = false;
    socket.on("data", () => {
      if (started) {
        queries++;
        return;
      }
      started = true;
      // AuthenticationOk, then ReadyForQuery (idle).
      socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://gp@127.0.0.1:${port}/gp`,
    queries: () => queries,
    connections: () => sockets.size,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(Uint8Array.from(chunk as Uint8Array));
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("database transfer", () => {
  it("copies each live kind, skips expired records, and streams a multi-chunk upload", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    const fixture = await seed(source);
    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
    });

    expect(result.counts).toEqual({
      shares: 1,
      updates: 1,
      snapshots: 2,
      uploads: 1,
      labs: 1,
      labels: 1,
      settings: 1,
      audit: 1,
    });
    expect(await destination.shares.get(shareId)).toEqual(fixture.share);
    expect(await destination.shares.get("Expire01")).toBeNull();
    for (const skipped of ["Expire01", "Missing1"]) {
      expect(await destination.updates.read(skipped, 0)).toEqual([]);
      expect(await destination.snapshots.latest(skipped, "compact")).toBeNull();
      expect(await destination.labels.get(labelClientId, skipped)).toBeNull();
    }
    expect(await destination.labs.get("LabOld01")).toBeNull();
    expect(await destination.updates.read(shareId, 0)).toEqual([{ seq: 7, data: fixture.binary }]);
    expect(await destination.updates.lastSeq(shareId)).toBe(7);
    expect(await destination.snapshots.get(shareId, "compact", 7)).toEqual({
      shareId,
      seq: 7,
      at: new Date(fixture.updateAt.getTime() + 7),
      kind: "compact",
      state: fixture.binary,
    });
    expect(await destination.snapshots.get(shareId, "history", 8)).toMatchObject({
      kind: "history",
      seq: 8,
    });
    expect(await destination.labs.get("Lab00001")).toEqual(await source.labs.get("Lab00001"));
    expect(await destination.labels.get(labelClientId, shareId)).toEqual(
      await source.labels.get(labelClientId, shareId),
    );
    expect(await destination.settings.get()).toEqual(await source.settings.get());
    expect(await destination.audit.list({ limit: 10 })).toEqual(
      await source.audit.list({ limit: 10 }),
    );

    const copiedUpload = await destination.files.openDownload(fixture.upload.id);
    const originalUpload = await source.files.openDownload(fixture.upload.id);
    if (!copiedUpload || !originalUpload) throw new Error("The upload was not copied");
    expect(copiedUpload.meta).toEqual(originalUpload.meta);
    const copiedBytes = await readStream(copiedUpload.stream);
    expect(copiedBytes.byteLength).toBe(fixture.uploadSize);
    expect(copiedBytes).toEqual(await readStream(originalUpload.stream));
  });

  it("stores every chunk of a multi-chunk upload unchanged in a SQL destination", async () => {
    const source = createMemoryStores();
    const fixture = await seed(source);
    const url = `sqlite:${join(await tempDir(), "uploads.sqlite")}`;
    const result = await copyDatabase("memory:", url, { openStores: openWithMemorySource(source) });
    expect(result.counts.uploads).toBe(1);
    const opened = await openStores(url);
    try {
      const copied = await opened.stores.files.openDownload(fixture.upload.id);
      const original = await source.files.openDownload(fixture.upload.id);
      if (!copied || !original) throw new Error("The upload was not copied");
      expect(await readStream(copied.stream)).toEqual(await readStream(original.stream));
    } finally {
      await opened.close();
    }
  });

  it("refuses a destination that already has a record", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    await destination.shares.create(sampleShare());
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
    expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
  });

  it("fails verification and leaves the copied destination intact", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    const actual = transferBackend(destination);
    const mismatching: TransferBackend = {
      ...actual,
      async *exportAll(cutoff) {
        for await (const item of actual.exportAll(cutoff)) {
          if (item.kind === "shares") yield { ...item, record: { ...item.record, title: "wrong" } };
          else yield item;
        }
      },
    };
    registerTransferBackend(destination, mismatching);
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
    expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
  });

  it("refuses identical URLs before opening either backend", async () => {
    let opened = false;
    await expect(
      copyDatabase("sqlite:/tmp/gp-copy-same.db", "sqlite:/tmp/gp-copy-same.db", {
        openStores: async () => {
          opened = true;
          throw new Error("must not open");
        },
      }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
    expect(opened).toBe(false);
  });

  it("refuses an unsupported URL scheme", async () => {
    await expect(copyDatabase("couchdb://localhost/data", "memory://")).rejects.toBeInstanceOf(
      CopyRefusedError,
    );
  });

  it("copies member lists longer than one page in order", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    const clients = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `${prefix}${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      );
    const share = { ...sampleShare(), savedBy: clients("b", 300), bans: clients("a", 200) };
    await source.shares.create(share);
    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
      batchRecords: 2,
    });
    expect(result.counts.shares).toBe(1);
    expect(await destination.shares.get(shareId)).toEqual(share);
  });

  it("verifies a destination that returns records in a different order", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    for (const id of ["a0000001", "B0000001", "c0000001", "A0000002"])
      await source.shares.create({ ...sampleShare(), id });
    await source.audit.append({ at: new Date(1), actor: ownerId, ip: "192.0.2.1", action: "a" });
    await source.audit.append({ at: new Date(2), actor: ownerId, ip: "192.0.2.1", action: "b" });
    wrapExport(destination, async function* (actual, cutoff) {
      const items: TransferItem[] = [];
      for await (const item of actual.exportAll(cutoff)) items.push(item);
      yield* items.reverse();
    });
    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
    });
    expect(result.counts).toMatchObject({ shares: 4, audit: 2 });
  });

  it("fails when a record disappears between the copy and the second source read", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    wrapExport(source, async function* (actual, cutoff, call) {
      // A deletion after the copy read the share.
      if (call === 2) await source.shares.delete(shareId);
      yield* actual.exportAll(cutoff);
    });
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
    expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
  });

  it("fails when a live lab disappears before the copy reads it", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    wrapExport(source, async function* (actual, cutoff, call) {
      // A deletion after the initial count but before both source reads.
      if (call === 1) await source.labs.delete("Lab00001");
      yield* actual.exportAll(cutoff);
    });
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
  });

  it("refuses audit details that are not plain JSON before writing", async () => {
    // biome-ignore lint/suspicious/noSparseArray: a hole is one of the refused shapes.
    const sparse = [1, , 3];
    for (const detail of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      { list: [1, undefined] },
      { list: sparse },
      { retained: 1, dropped: undefined },
      { at: new Date(5) },
      { nested: [{ id: new Uint8Array(2) }] },
      { nested: new Map([["kept", 1]]) },
      { value: 1n },
    ]) {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      const append = (detail: unknown) =>
        source.audit.append({
          at: new Date(1),
          actor: ownerId,
          ip: "192.0.2.1",
          action: "x",
          detail,
        });
      await append(detail);
      await append({ plain: [true, null, 1.5, "text", { deep: {} }] });
      const path = join(await tempDir(), "audit.sqlite");
      await expect(
        copyDatabase("memory:", `sqlite:${path}`, { openStores: openWithMemorySource(source) }),
      ).rejects.toThrow(new CopyRefusedError("Audit details are not plain JSON in 1 record"));
      // Refused before the destination was even opened.
      expect(existsSync(path)).toBe(false);
    }

    const source = createMemoryStores();
    for (const detail of [{ a: undefined }, [undefined], { ok: 1 }, Number.NaN])
      await source.audit.append({
        at: new Date(1),
        actor: ownerId,
        ip: "192.0.2.1",
        action: "x",
        detail,
      });
    const destination = createMemoryStores();
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toThrow(new CopyRefusedError("Audit details are not plain JSON in 3 records"));
    expect(await transferBackend(destination).isEmpty()).toBe(true);
  });

  it("fails when an unsupported audit detail appears after the check", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    wrapExport(source, async function* (actual, cutoff, call) {
      if (call === 1)
        await source.audit.append({
          at: new Date(2),
          actor: ownerId,
          ip: "192.0.2.1",
          action: "x",
          detail: { dropped: undefined },
        });
      yield* actual.exportAll(cutoff);
    });
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
    expect(await destination.audit.list({ limit: 10 })).toEqual([]);
  });

  it("recreates a missing upload capacity row and checks its value", async () => {
    const source = createMemoryStores();
    await source.files.put({
      name: "a.bin",
      contentType: null,
      ownerId,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      data: new Uint8Array(1234),
    });
    const url = `sqlite:${join(await tempDir(), "capacity.sqlite")}`;
    await (await openStores(url)).close();
    await sqlRun(url, "DELETE FROM upload_capacity");
    await copyDatabase("memory:", url, { openStores: openWithMemorySource(source) });
    expect(await capacityRows(url)).toEqual([{ id: 1, used_bytes: 1234 }]);
  });

  it("refuses an unexpected upload capacity row", async () => {
    const url = `sqlite:${join(await tempDir(), "extra.sqlite")}`;
    await (await openStores(url)).close();
    await sqlRun(url, "INSERT INTO upload_capacity (id,used_bytes) VALUES (2,0)");
    await expect(
      copyDatabase("memory:", url, { openStores: openWithMemorySource(createMemoryStores()) }),
    ).rejects.toThrow(new CopyRefusedError("Destination is not empty"));
  });

  it("fails verification when the recomputed upload counter is wrong", async () => {
    const source = createMemoryStores();
    await source.files.put({
      name: "a.bin",
      contentType: null,
      ownerId,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      data: new Uint8Array(10),
    });
    const url = `sqlite:${join(await tempDir(), "counter.sqlite")}`;
    await expect(
      copyDatabase("memory:", url, {
        openStores: async (target) => {
          const opened = await openWithMemorySource(source)(target);
          if (target === url) {
            const actual = transferBackend(opened.stores);
            registerTransferBackend(opened.stores, {
              ...actual,
              recomputeCounters: () => sqlRun(url, "UPDATE upload_capacity SET used_bytes=7"),
            });
          }
          return opened;
        },
      }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
  });

  it("accepts MongoDB seed lists without parsing them as URLs", async () => {
    const seedList = "mongodb://db1.invalid:27017,db2.invalid:27018/gp?replicaSet=rs0";
    for (const [from, to] of [
      [seedList, "memory://"],
      ["memory:", seedList],
    ] as const) {
      const source = createMemoryStores();
      const destination = createMemoryStores();
      await source.shares.create(sampleShare());
      const result = await copyDatabase(from, to, {
        openStores: async (url) => ({
          stores: url === from ? source : destination,
          close: async () => undefined,
          kind: "memory",
        }),
      });
      expect(result.counts.shares).toBe(1);
    }
  });

  it("fails a malformed MongoDB URL without exposing it", async () => {
    const url = "mongodb://copy-user:secret-value@localhost/gp?authMechanism=NOT-A-MECHANISM";
    const error = await copyDatabase("memory:", url, {
      openStores: openWithMemorySource(createMemoryStores()),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CopyFailureError);
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(String(error)).not.toContain("secret-value");
  });

  it("identifies MongoDB databases by the servers' hello replies", () => {
    const identity = (fields: Partial<MongoIdentity>): MongoIdentity => ({
      database: "gp",
      hosts: [],
      ...fields,
    });
    const node = { processId: "65f000000000000000000001" };
    expect(sameMongoDatabase(identity(node), identity(node))).toBe(true);
    expect(sameMongoDatabase(identity(node), identity({ ...node, database: "other" }))).toBe(false);
    expect(
      sameMongoDatabase(
        identity({ processId: "65f000000000000000000001" }),
        identity({ processId: "65f000000000000000000002" }),
      ),
    ).toBe(false);
    const member = identity({ setName: "rs0", hosts: ["db1:27017", "db2:27017"] });
    expect(sameMongoDatabase(member, identity({ setName: "rs0", hosts: ["db1:27017"] }))).toBe(
      true,
    );
    expect(sameMongoDatabase(member, identity({ setName: "rs0", hosts: ["db9:27017"] }))).toBe(
      false,
    );
    expect(sameMongoDatabase(member, identity({ setName: "rs1", hosts: ["db1:27017"] }))).toBe(
      false,
    );
  });

  it("treats default SQL ports and databases as the same database", async () => {
    const neverOpen = async (): Promise<OpenedStores> => {
      throw new Error("must not open");
    };
    for (const [from, to] of [
      ["postgres://gp@db.example/gp", "postgresql://gp@DB.example:5432/gp"],
      ["postgres://gp@db.example/", "postgres://gp@db.example:5432/gp"],
      ["mysql://root@db.example/gp", "mariadb://root@db.example:3306/gp"],
    ] as const)
      await expect(copyDatabase(from, to, { openStores: neverOpen })).rejects.toBeInstanceOf(
        CopyRefusedError,
      );
  });

  it("follows SQLite symlinks and keeps the driver's literal path rules", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "real.sqlite"), "");
    await symlink(join(dir, "real.sqlite"), join(dir, "link.sqlite"));
    await expect(
      copyDatabase(`sqlite:${join(dir, "real.sqlite")}`, `sqlite:${join(dir, "link.sqlite")}`, {
        openStores: async () => {
          throw new Error("must not open");
        },
      }),
    ).rejects.toBeInstanceOf(CopyRefusedError);

    // sqlite:<path> is taken literally, so %41 is not "A".
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await source.shares.create(sampleShare());
    const from = `sqlite:${join(dir, "x%41.sqlite")}`;
    const result = await copyDatabase(from, `sqlite:${join(dir, "xA.sqlite")}`, {
      openStores: async (url) => ({
        stores: url === from ? source : destination,
        close: async () => undefined,
        kind: "sqlite",
      }),
    });
    expect(result.counts.shares).toBe(1);
  });

  it("skips records expiring within the margin, with one cutoff for every read", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    const at = (offset: number) => new Date(t0 + MARGIN + offset);
    const source = createMemoryStores();
    const destination = createMemoryStores();
    const uploads = new Map<string, string>();
    const putUpload = async (name: string, expiresAt: Date, shareId?: string) => {
      const meta = await source.files.put({
        name,
        contentType: null,
        ownerId,
        ...(shareId ? { shareId } : {}),
        expiresAt,
        data: new Uint8Array([name.length]),
      });
      uploads.set(name, meta.id);
    };
    const shares = { ShBelow1: at(-1), ShEqual1: at(0), ShAbove1: at(1), ShNull01: null };
    for (const [id, expiresAt] of Object.entries(shares)) {
      await source.shares.create({
        ...sampleShare(),
        id,
        saved: expiresAt === null,
        savedBy: [],
        expiresAt,
      });
      await source.updates.append(id, [{ seq: 1, data: new Uint8Array([1]) }], new Date(t0));
      await source.labels.set(labelClientId, id, { folder: null, tags: [] }, new Date(t0));
      // A child upload that outlives the cutoff itself goes or stays with its share.
      await putUpload(`${id}.bin`, new Date("2099-01-01T00:00:00.000Z"), id);
    }
    for (const [name, offset] of [
      ["loose-below", -1],
      ["loose-equal", 0],
      ["loose-above", 1],
    ] as const)
      await putUpload(name, at(offset));
    await putUpload("own-equal", at(0), "ShAbove1");
    await putUpload("own-above", at(1), "ShAbove1");
    for (const [id, offset] of [
      ["LabBelow", -1],
      ["LabEqual", 0],
      ["LabAbove", 1],
    ] as const)
      await source.labs.create({
        id,
        title: id,
        ownerId,
        joinCode: "123456",
        templateShareId: null,
        locked: false,
        students: [],
        createdAt: new Date(t0),
        expiresAt: at(offset),
      });
    const cutoffs: number[] = [];
    for (const stores of [source, destination])
      wrapTransfer(stores, (actual) => ({
        exportAll: (cutoff) => {
          cutoffs.push(cutoff.getTime());
          return actual.exportAll(cutoff);
        },
        countLive: (cutoff) => {
          cutoffs.push(cutoff.getTime());
          return actual.countLive(cutoff);
        },
      }));

    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
    });
    // Initial count, copy, second source read and destination read share the cutoff.
    expect(cutoffs).toEqual(Array(4).fill(t0 + MARGIN));
    expect(result.counts).toMatchObject({ shares: 2, updates: 2, labels: 2, labs: 1, uploads: 4 });
    for (const [id, copied] of [
      ["ShBelow1", false],
      ["ShEqual1", false],
      ["ShAbove1", true],
      ["ShNull01", true],
    ] as const) {
      expect(await destination.shares.get(id)).toEqual(copied ? await source.shares.get(id) : null);
      expect((await destination.updates.read(id, 0)).length).toBe(copied ? 1 : 0);
      expect(await destination.labels.get(labelClientId, id)).toEqual(
        copied ? await source.labels.get(labelClientId, id) : null,
      );
    }
    for (const [id, copied] of [
      ["LabBelow", false],
      ["LabEqual", false],
      ["LabAbove", true],
    ] as const)
      expect(await destination.labs.get(id)).toEqual(copied ? await source.labs.get(id) : null);
    const copiedUploads: string[] = [];
    for (const [name, id] of uploads)
      if (await destination.files.meta(id)) copiedUploads.push(name);
    expect(copiedUploads.sort()).toEqual([
      "ShAbove1.bin",
      "ShNull01.bin",
      "loose-above",
      "own-above",
    ]);
  });

  it("ignores records within the margin that disappear during the count or a later read", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    const soon = new Date(Date.now() + 5_000);
    const soonShare = {
      ...sampleShare(),
      id: "Soon0001",
      saved: false,
      savedBy: [],
      expiresAt: soon,
    };
    await source.shares.create(soonShare);
    await source.shares.create({ ...soonShare, id: "Soon0002" });
    await source.labs.create({
      id: "LabSoon1",
      title: "expiring",
      ownerId,
      joinCode: "222222",
      templateShareId: null,
      locked: false,
      students: [],
      createdAt: new Date(),
      expiresAt: soon,
    });
    const actual = transferBackend(source);
    let calls = 0;
    registerTransferBackend(source, {
      ...actual,
      // TTL deletions between the share count and the lab count, and before the second read.
      async countLive(cutoff) {
        const { shares } = await actual.countLive(cutoff);
        await source.labs.delete("LabSoon1");
        await source.shares.delete("Soon0001");
        const { labs } = await actual.countLive(cutoff);
        return { shares, labs };
      },
      exportAll: async function* (cutoff) {
        if (++calls === 2) await source.shares.delete("Soon0002");
        yield* actual.exportAll(cutoff);
      },
    });
    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
    });
    expect(result.counts).toMatchObject({ shares: 1, labs: 1 });
    expect(await destination.labs.get("LabSoon1")).toBeNull();
    expect(await destination.shares.get("Soon0002")).toBeNull();
  });

  it("fails at the deadline even when every read matches", async () => {
    for (const [elapsed, wall, failed] of [
      [DEADLINE - 1, 0, false],
      [DEADLINE, 0, true],
      // A wall clock set back an hour does not hide the elapsed time.
      [DEADLINE, -60 * MINUTE, true],
    ] as const) {
      const clocks = fakeClocks();
      const source = createMemoryStores();
      const destination = createMemoryStores();
      await seed(source);
      wrapTransfer(destination, (actual) => ({
        // The last read of the run ends here.
        async uploadCounter() {
          clocks.monotonic = elapsed;
          clocks.wall = wall;
          return actual.uploadCounter();
        },
      }));
      const outcome = await copyDatabase("memory:", "memory://", {
        openStores: openPair(source, destination),
      }).catch((caught: unknown) => caught);
      if (failed) {
        expect(outcome).toBeInstanceOf(CopyDeadlineError);
        expect((outcome as CopyDeadlineError).counts).toMatchObject({ shares: 1, audit: 1 });
      } else expect(outcome).toMatchObject({ counts: { shares: 1, audit: 1 } });
      // The destination is left for the operator either way.
      expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
      vi.restoreAllMocks();
    }
  });

  it("stops copying once the deadline has passed", async () => {
    const clocks = fakeClocks();
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    let reads = 0;
    wrapExport(source, async function* (actual, cutoff) {
      reads++;
      for await (const item of actual.exportAll(cutoff)) {
        yield item;
        if (item.kind === "shares") clocks.monotonic = DEADLINE + MINUTE;
      }
    });
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyDeadlineError);
    expect(reads).toBe(1);
  });

  it("refuses a MongoDB server whose clock is more than 2 minutes off", async () => {
    for (const [role, localTime, refused] of [
      ["memory:", 3 * MINUTE, true],
      ["memory:", -3 * MINUTE, true],
      ["memory://", 2 * MINUTE + 5_000, true],
      ["memory://", undefined, true],
      ["memory:", 90_000, false],
      ["memory://", -90_000, false],
    ] as const) {
      const source = createMemoryStores();
      const destination = createMemoryStores();
      await source.shares.create(sampleShare());
      const client = helloClient({
        localTime: localTime === undefined ? undefined : new Date(Date.now() + localTime),
      });
      const copy = copyDatabase("memory:", "memory://", {
        openStores: openMemory({ "memory:": source, "memory://": destination }, { [role]: client }),
      });
      if (refused) {
        await expect(copy).rejects.toThrow(
          new CopyRefusedError(
            "MongoDB server clock differs from this host by more than 2 minutes",
          ),
        );
        expect(await transferBackend(destination).isEmpty()).toBe(true);
      } else expect((await copy).counts.shares).toBe(1);
    }
  });

  it("refuses a MongoDB source that is not the primary before opening the destination", async () => {
    const noPrimary = {
      db: () => ({
        databaseName: "gp",
        command: async () => {
          throw Object.assign(new Error("Server selection timed out"), {
            name: "MongoServerSelectionError",
          });
        },
      }),
    } as unknown as MongoClient;
    // A direct connection to a secondary, and a connection that finds no primary at all.
    for (const client of [
      helloClient({ isWritablePrimary: false, secondary: true, setName: "rs0" }),
      noPrimary,
    ]) {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      const open = openMemory(
        { "memory:": source, "memory://": createMemoryStores() },
        { "memory:": client },
      );
      const opened: string[] = [];
      await expect(
        copyDatabase("memory:", "memory://", {
          openStores: (url) => {
            opened.push(url);
            return open(url);
          },
        }),
      ).rejects.toThrow(new CopyRefusedError("MongoDB source is not the primary"));
      expect(opened).toEqual(["memory:"]);
    }
  });

  it("compares every advertised replica set member", async () => {
    const copy = async (
      from: Record<string, unknown>,
      to: Record<string, unknown>,
      toDb = "gp",
    ) => {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      return copyDatabase("memory:", "memory://", {
        openStores: openMemory(
          { "memory:": source, "memory://": createMemoryStores() },
          { "memory:": helloClient(from), "memory://": helloClient(to, toDb) },
        ),
      });
    };
    const process = (processId: string) => ({ topologyVersion: { processId } });
    const same = new CopyRefusedError("Source and destination are the same");
    const primary = {
      ...process("p1"),
      setName: "rs0",
      hosts: ["db1:27017"],
      passives: ["db2:27017"],
      primary: "db1:27017",
      me: "db1:27017",
    };
    // A passive answering as an arbiter's peer: only the passive and the arbiter list overlap.
    await expect(
      copy(primary, {
        ...process("p2"),
        setName: "rs0",
        hosts: ["db3:27017"],
        arbiters: ["DB2:27017"],
      }),
    ).rejects.toThrow(same);
    // A hidden member lists no hosts, only itself and the primary.
    await expect(
      copy(primary, { ...process("p3"), setName: "rs0", me: "hidden:27017", primary: "db1:27017" }),
    ).rejects.toThrow(same);
    // The same process under any name.
    await expect(copy(process("p1"), process("p1"))).rejects.toThrow(same);
    // Copied: another database on the same process, a set of the same name with no member in
    // common, and two mongos routers (not detected; the emptiness check still applies).
    expect((await copy(process("p1"), process("p1"), "other")).counts.shares).toBe(1);
    expect(
      (await copy(primary, { ...process("p4"), setName: "rs0", hosts: ["db9:27017"] })).counts
        .shares,
    ).toBe(1);
    expect(
      (await copy({ ...process("r1"), msg: "isdbgrid" }, { ...process("r2"), msg: "isdbgrid" }))
        .counts.shares,
    ).toBe(1);
  });

  it("keeps socket paths case-sensitive and follows MySQL socketPath", async () => {
    const neverOpen = async (): Promise<OpenedStores> => {
      throw new Error("must not open");
    };
    for (const [from, to] of [
      [
        "postgres://gp@localhost/gp?host=/run/gp-a",
        "postgresql://gp@db.invalid:5432/gp?host=%2Frun%2Fgp-a",
      ],
      ["postgres://gp@%2Frun%2Fgp-a/gp", "postgres://gp@localhost/gp?host=/run/gp-a"],
      [
        "postgres://gp@localhost/gp?host=/run/b&host=/run/gp-a",
        "postgres://gp@localhost/gp?host=/run/gp-a",
      ],
      [
        "mysql://root@db1/gp?socketPath=/run/mysqld/gp.sock",
        "mariadb://root@db2:3307/gp?socketPath=%22/run/mysqld/gp.sock%22",
      ],
    ] as const)
      await expect(copyDatabase(from, to, { openStores: neverOpen })).rejects.toThrow(
        new CopyRefusedError("Source and destination are the same"),
      );
    for (const [from, to] of [
      ["postgres://gp@localhost/gp?host=/run/GP-A", "postgres://gp@localhost/gp?host=/run/gp-a"],
      [
        "mysql://root@localhost/gp?socketPath=/run/mysqld/A.sock",
        "mysql://root@localhost/gp?socketPath=/run/mysqld/a.sock",
      ],
      ["mysql://root@localhost/gp?socketPath=/run/mysqld/a.sock", "mysql://root@localhost/gp"],
    ] as const) {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      const result = await copyDatabase(from, to, {
        openStores: openMemory({ [from]: source, [to]: createMemoryStores() }),
      });
      expect(result.counts.shares).toBe(1);
    }
  });

  it("waits for a lagging majority commit point and refuses a source that stays behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opTime = (i: number) => ({ ts: new Timestamp({ t: 1_800_000_000, i }), t: 4 });
    const behind = { setName: "rs0", lastWrite: { opTime: opTime(9), majorityOpTime: opTime(8) } };
    const current = { setName: "rs0", lastWrite: { opTime: opTime(9), majorityOpTime: opTime(9) } };
    for (const [replies, hellos, refusedAt] of [
      // A replica set member that is up to date, and a standalone server, which reports neither.
      [[current], 1, undefined],
      [[{}], 1, undefined],
      // Behind for the first two checks, at 0 and 1 s, then caught up at 3 s.
      [[behind, behind, current], 3, undefined],
      // Behind, or silent about its commit point, through every check until 30 s.
      [[behind], 6, 30_000],
      [[{ setName: "rs0" }], 6, 30_000],
    ] as const) {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      const hello = helloSequence(replies);
      const open = openMemory(
        { "memory:": source, "memory://": createMemoryStores() },
        { "memory:": hello.client },
      );
      const opened: string[] = [];
      let settled = false;
      const outcome = copyDatabase("memory:", "memory://", {
        openStores: (url) => {
          opened.push(url);
          return open(url);
        },
      })
        .catch((caught: unknown) => caught)
        .finally(() => {
          settled = true;
        });
      if (refusedAt) {
        await vi.advanceTimersByTimeAsync(refusedAt - 1);
        expect(settled).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await outcome;
      expect(hello.calls()).toBe(hellos);
      if (refusedAt) {
        expect(result).toBeInstanceOf(CopyRefusedError);
        expect((result as Error).message).toBe(
          "MongoDB source has writes not yet replicated to a majority",
        );
        expect(opened).toEqual(["memory:"]);
      } else expect(result).toMatchObject({ counts: { shares: 1 } });
    }
  });

  it("scales the expiry margin and the deadline with the copy window", async () => {
    const lab = (id: string, joinCode: string, minutes: number) => ({
      id,
      title: id,
      ownerId,
      joinCode,
      templateShareId: null,
      locked: false,
      students: [],
      createdAt: new Date(1),
      expiresAt: new Date(Date.now() + minutes * MINUTE),
    });
    // A 60-minute window: a 60-minute margin and a 55-minute deadline.
    for (const [elapsed, failed] of [
      [55 * MINUTE - 1, false],
      [55 * MINUTE, true],
    ] as const) {
      const clocks = fakeClocks();
      const source = createMemoryStores();
      const destination = createMemoryStores();
      await source.labs.create(lab("LabSoon1", "100001", 59));
      await source.labs.create(lab("LabLate1", "100002", 61));
      wrapTransfer(destination, (actual) => ({
        async uploadCounter() {
          clocks.monotonic = elapsed;
          return actual.uploadCounter();
        },
      }));
      const outcome = await copyDatabase("memory:", "memory://", {
        openStores: openPair(source, destination),
        windowMinutes: 60,
      }).catch((caught: unknown) => caught);
      if (failed) {
        expect(outcome).toBeInstanceOf(CopyDeadlineError);
        expect(outcome).toMatchObject({ minutes: 55, counts: { labs: 1 } });
      } else expect(outcome).toMatchObject({ counts: { labs: 1 } });
      expect(await destination.labs.get("LabSoon1")).toBeNull();
      expect((await destination.labs.get("LabLate1"))?.title).toBe("LabLate1");
      vi.restoreAllMocks();
    }
  });

  it("refuses a copy window outside 15 to 1440 whole minutes", async () => {
    const neverOpen = async (): Promise<OpenedStores> => {
      throw new Error("must not open");
    };
    for (const windowMinutes of [14, 1441, 15.5, Number.NaN, -15])
      await expect(
        copyDatabase("memory:", "memory://", { openStores: neverOpen, windowMinutes }),
      ).rejects.toThrow(
        new CopyRefusedError("Copy window must be a whole number of minutes from 15 to 1440"),
      );
    for (const windowMinutes of [15, 1440]) {
      const source = createMemoryStores();
      await source.shares.create(sampleShare());
      const result = await copyDatabase("memory:", "memory://", {
        openStores: openPair(source, createMemoryStores()),
        windowMinutes,
      });
      expect(result.counts.shares).toBe(1);
    }
  });

  it("fails a stalled SQL destination after the operation timeout instead of hanging", async () => {
    const source = createMemoryStores();
    await seed(source);
    const url = `sqlite:${join(await tempDir(), "stalled.sqlite")}`;
    const driver = await openSqlDriver(url);
    let stalled = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = copyDatabase("memory:", url, {
        openStores: async (target) => {
          const opened = await openWithMemorySource(source)(target);
          if (target === url)
            // The destination answers reads but never finishes a write transaction.
            registerTransferBackend(
              opened.stores,
              createSqlTransferBackend({
                ...driver,
                transaction: () => {
                  stalled = true;
                  return new Promise<never>(() => undefined);
                },
              }),
            );
          return opened;
        },
      }).catch((caught: unknown) => caught);
      while (!stalled) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
      const error = await outcome;
      expect(error).toBeInstanceOf(CopyFailureError);
      expect(error).toMatchObject({ code: "ETIMEDOUT", destinationWritten: true });
    } finally {
      vi.useRealTimers();
      await driver.close();
    }
  });

  it("tells apart a failure before the first write to the destination", async () => {
    const dir = await tempDir();
    const source = `sqlite:${join(dir, "source.sqlite")}`;
    await (await openStores(source)).close();
    // The destination's directory is missing: opening it fails before anything is written.
    const error = await copyDatabase(source, `sqlite:${join(dir, "missing", "x.sqlite")}`).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CopyFailureError);
    expect(error).toMatchObject({ code: "SQLITE_CANTOPEN", destinationWritten: false });
  });

  it("refuses in-memory databases outside the test seam", async () => {
    const dir = await tempDir();
    const file = `sqlite:${join(dir, "kept.sqlite")}`;
    await (await openStores(file)).close();
    const target = join(dir, "never.sqlite");
    for (const [from, to] of [
      ["memory:", `sqlite:${target}`],
      [file, "memory://"],
      ["sqlite::memory:", `sqlite:${target}`],
      [file, "sqlite://:memory:"],
      [file, "sqlite:"],
    ] as const)
      await expect(copyDatabase(from, to)).rejects.toThrow(
        new CopyRefusedError("Source and destination must be persistent databases"),
      );
    expect(existsSync(target)).toBe(false);
  });

  it("refuses SQLite file: URIs as source or destination before opening either", async () => {
    const dir = await tempDir();
    const kept = join(dir, "kept.sqlite");
    await (await openStores(`sqlite:${kept}`)).close();
    const target = join(dir, "never.sqlite");
    const neverOpen = async (): Promise<OpenedStores> => {
      throw new Error("must not open");
    };
    for (const [from, to] of [
      // No path: a temporary database. Escaped options: mode=memory and vfs=memdb.
      [`sqlite:${kept}`, "sqlite:file:"],
      [`sqlite:${kept}`, `sqlite:file:${target}?mode=%6demory`],
      [`sqlite:${kept}`, `sqlite:file:${target}?%76fs=memdb`],
      [`sqlite:${kept}`, "sqlite:file::memory:?cache=shared"],
      // Plain file: paths, in any case, on either side.
      [`sqlite:${kept}`, `sqlite:file:${target}`],
      [`sqlite:${kept}`, `sqlite:FILE:${target}`],
      [`sqlite:file:${kept}`, `sqlite:${target}`],
      [`sqlite:file://${kept}?mode=ro`, `sqlite:${target}`],
    ] as const) {
      const refused = new CopyRefusedError(
        "SQLite databases must be plain file paths, not file: URIs",
      );
      await expect(copyDatabase(from, to)).rejects.toThrow(refused);
      await expect(copyDatabase(from, to, { openStores: neverOpen })).rejects.toThrow(refused);
    }
    expect(existsSync(target)).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(["kept.sqlite"]);
  });

  it("identifies MySQL databases the way mysql2 parses their URLs", async () => {
    // The pinned driver's own parser, which the copy's identity must agree with.
    const { ConnectionConfig } = createRequire(import.meta.url)("mysql2") as {
      ConnectionConfig: new (options: {
        uri: string;
      }) => { host: string; port: number; socketPath?: unknown; database?: string };
    };
    const connectsTo = (url: string) => {
      // As sql/driver.ts hands the URL to mysql2.
      const config = new ConnectionConfig({
        uri: new URL(url.replace(/^mariadb:/, "mysql:")).href,
      });
      return config.socketPath
        ? `socket:${String(config.socketPath)}:${config.database}`
        : `${config.host.toLowerCase()}:${config.port}:${config.database}`;
    };
    const urls = [
      "mysql://root@db1/gp",
      "mariadb://root@DB1:3306/gp",
      // URL parts win over query parameters of the same name.
      "mysql://root@db9/other?host=db1&database=gp",
      "mysql://root@db1/other?database=%22gp%22",
      "mysql://root@db1/gp?database=other",
      "mysql://root@db1/gp?host=db2&port=3307",
      "mysql://root@db1:3307/gp",
      "mariadb://root@db1/gp?port=3307",
      // Query-only keys take their first value, as JSON when it parses.
      "mysql://root@db1/gp?socketPath=/run/a.sock&socketPath=/run/b.sock",
      "mysql://root@db2/gp?socketPath=%22/run/a.sock%22",
      "mysql://root@db1/gp?socketPath=/run/b.sock&socketPath=/run/a.sock",
      "mysql://root@db1/gp?socketPath=null",
      "mysql://root@db1/gp?socketPath=",
      "mysql://root@[::1]/gp",
      "mysql://root@[::1]:3306/gp",
      "mysql:///gp",
      "mysql://root@localhost/gp",
    ];
    let same = 0;
    for (const from of urls)
      for (const to of urls) {
        if (from === to) continue;
        const source = createMemoryStores();
        await source.shares.create(sampleShare());
        const outcome = await copyDatabase(from, to, {
          openStores: openMemory({ [from]: source, [to]: createMemoryStores() }),
        }).catch((caught: unknown) => caught);
        if (connectsTo(from) === connectsTo(to)) {
          same++;
          expect(outcome, `${from} and ${to}`).toEqual(
            new CopyRefusedError("Source and destination are the same"),
          );
        } else expect(outcome, `${from} and ${to}`).toMatchObject({ counts: { shares: 1 } });
      }
    // Both outcomes occur, so the comparison is not vacuous.
    expect(same).toBeGreaterThan(10);
  });

  it("opens a SQL source as it is and refuses a missing or unknown schema version", async () => {
    const dir = await tempDir();
    const destination = `sqlite:${join(dir, "destination.sqlite")}`;
    const refused = new CopyRefusedError("SQL source schema version is missing or not supported");
    // Without a schema: opening it through the stores opener would create every table in it.
    const bare = `sqlite:${join(dir, "bare.sqlite")}`;
    await sqlRun(bare, "CREATE TABLE unrelated (id INTEGER)");
    await expect(copyDatabase(bare, destination)).rejects.toThrow(refused);
    expect(
      await sqlAll(bare, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).toEqual([{ name: "unrelated" }]);
    // A schema version this code does not know, alone or after its own.
    for (const versions of [[2], [1, 2]]) {
      const url = `sqlite:${join(dir, `v${versions.join("-")}.sqlite`)}`;
      await (await openStores(url)).close();
      await sqlRun(url, "DELETE FROM schema_version");
      for (const version of versions)
        await sqlRun(
          url,
          `INSERT INTO schema_version (version, applied_at) VALUES (${version}, 0)`,
        );
      await expect(copyDatabase(url, destination)).rejects.toThrow(refused);
      expect(
        (await sqlAll(url, "SELECT version FROM schema_version ORDER BY version")).map((row) =>
          Number(row.version),
        ),
      ).toEqual(versions);
    }
    // A missing file is not created.
    const missing = join(dir, "missing.sqlite");
    await expect(copyDatabase(`sqlite:${missing}`, destination)).rejects.toThrow(refused);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(dir, "destination.sqlite"))).toBe(false);
  });

  it("reads a SQLite source without writing to it or changing its journal mode", async () => {
    /** The source's bytes, its journal mode bytes and every file in its folder. */
    const state = async (path: string) => {
      const bytes = await readFile(path);
      return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        journal: [bytes[18], bytes[19]],
        files: (await readdir(dirname(path))).sort(),
      };
    };
    const seeded = async (path: string, journal: "DELETE" | "WAL") => {
      const opened = await openStores(`sqlite:${path}`);
      await seed(opened.stores);
      await opened.close();
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=${journal}`);
      db.close();
      return state(path);
    };
    const destinations = await tempDir();
    for (const journal of ["DELETE", "WAL"] as const) {
      const path = join(await tempDir(), "source.sqlite");
      const before = await seeded(path, journal);
      expect(before.journal).toEqual(journal === "WAL" ? [2, 2] : [1, 1]);
      expect(before.files).toEqual(["source.sqlite"]);
      const destination = `sqlite:${join(destinations, `${journal}.sqlite`)}`;
      // Success, then a refusal after the source was opened (the destination is no longer empty).
      expect((await copyDatabase(`sqlite:${path}`, destination)).counts.shares).toBe(1);
      expect(await state(path), journal).toEqual(before);
      await expect(copyDatabase(`sqlite:${path}`, destination)).rejects.toThrow(
        new CopyRefusedError("Destination is not empty"),
      );
      expect(await state(path), journal).toEqual(before);
    }

    // A schema version this code does not know: refused, the source unchanged.
    const unknown = join(await tempDir(), "unknown.sqlite");
    await seeded(unknown, "WAL");
    await sqlRun(`sqlite:${unknown}`, "UPDATE schema_version SET version=2");
    const db = new DatabaseSync(unknown);
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
    const unknownBefore = await state(unknown);
    await expect(
      copyDatabase(`sqlite:${unknown}`, `sqlite:${join(destinations, "unknown.sqlite")}`),
    ).rejects.toThrow(
      new CopyRefusedError("SQL source schema version is missing or not supported"),
    );
    expect(await state(unknown)).toEqual(unknownBefore);

    // A WAL-mode source still open elsewhere has -wal and -shm files, which reading it would write.
    const busy = join(await tempDir(), "busy.sqlite");
    await seeded(busy, "WAL");
    const other = new DatabaseSync(busy);
    try {
      other.exec("PRAGMA journal_mode=WAL");
      await expect(
        copyDatabase(`sqlite:${busy}`, `sqlite:${join(destinations, "busy.sqlite")}`),
      ).rejects.toThrow(
        new CopyRefusedError(
          "SQLite source is open elsewhere or was not closed cleanly: it has -wal or -shm files",
        ),
      );
    } finally {
      other.close();
    }
    expect(existsSync(join(destinations, "busy.sqlite"))).toBe(false);
  });

  it("fails when another connection opens a WAL-mode source during the copy", async () => {
    const path = join(await tempDir(), "source.sqlite");
    const opened = await openStores(`sqlite:${path}`);
    await seed(opened.stores);
    await opened.close();
    const destination = join(await tempDir(), "destination.sqlite");
    // Nothing locks the immutable source, so a service started meanwhile shows only by its files.
    // It starts at the copy's first deadline check, once the destination exists.
    let other: DatabaseSync | undefined;
    const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (!other && existsSync(destination)) {
        other = new DatabaseSync(path);
        other.exec("PRAGMA journal_mode=WAL");
      }
      return now();
    });
    try {
      await expect(copyDatabase(`sqlite:${path}`, `sqlite:${destination}`)).rejects.toBeInstanceOf(
        CopyVerificationError,
      );
      expect(other).toBeDefined();
    } finally {
      other?.close();
    }
  });

  it("fails when another connection changes a SQLite source and closes before the verification", async () => {
    // The destination's counter query runs after the copy, before the source is read again.
    const afterCopy = "SELECT COALESCE(SUM(size),0) AS total FROM uploads WHERE complete=TRUE";
    const prepare = DatabaseSync.prototype.prepare;
    for (const journal of ["WAL", "DELETE"] as const)
      for (const change of [
        `UPDATE shares SET title='changed meanwhile' WHERE id='${shareId}'`,
        `DELETE FROM share_labels WHERE share_id='${shareId}'`,
        // A write to nothing the copy reads: only the file shows it.
        "PRAGMA user_version=7",
      ]) {
        // Small enough for every page to stay in the source connection's cache.
        const dir = await tempDir();
        const path = join(dir, "source.sqlite");
        const opened = await openStores(`sqlite:${path}`);
        await opened.stores.shares.create(sampleShare());
        await opened.stores.labels.set(
          labelClientId,
          shareId,
          { folder: null, tags: ["x"] },
          new Date("2026-10-22T09:08:07.006Z"),
        );
        await opened.close();
        const db = new DatabaseSync(path);
        db.exec(`PRAGMA journal_mode=${journal}`);
        db.close();
        let files: string[] | undefined;
        vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: DatabaseSync,
          ...args: Parameters<DatabaseSync["prepare"]>
        ) {
          if (!files && args[0] === afterCopy) {
            // A service commits a change and closes cleanly, which removes any -wal and -shm file.
            const other = new DatabaseSync(path);
            other.exec(change);
            other.close();
            files = readdirSync(dir).sort();
          }
          return prepare.apply(this, args);
        });
        const destination = join(await tempDir(), "destination.sqlite");
        await expect(
          copyDatabase(`sqlite:${path}`, `sqlite:${destination}`),
          `${journal}: ${change}`,
        ).rejects.toBeInstanceOf(CopyVerificationError);
        expect(files).toEqual(["source.sqlite"]);
        vi.restoreAllMocks();
      }
  });

  it("refuses a SQLite source that is not a regular file before opening it", async () => {
    const dir = await tempDir();
    const fifo = join(dir, "fifo.sqlite");
    execFileSync("mkfifo", [fifo]);
    const folder = join(dir, "folder.sqlite");
    await mkdir(folder);
    const socket = join(dir, "socket.sqlite");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    for (const [link, target] of [
      ["fifo-link.sqlite", fifo],
      ["device-link.sqlite", "/dev/null"],
      ["folder-link.sqlite", folder],
    ] as const)
      await symlink(target, join(dir, link));
    const destinations = await tempDir();
    try {
      for (const path of [
        fifo,
        folder,
        socket,
        "/dev/null",
        ...["fifo-link", "device-link", "folder-link"].map((link) => join(dir, `${link}.sqlite`)),
      ])
        await expect(
          copyDatabase(`sqlite:${path}`, `sqlite:${join(destinations, "destination.sqlite")}`),
          path,
        ).rejects.toThrow(new CopyRefusedError("SQLite source must be a regular file"));
      // Nothing holds the FIFO open for reading, and nothing was created.
      let code: unknown;
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch (error) {
        code = (error as NodeJS.ErrnoException).code;
      }
      expect(code).toBe("ENXIO");
      expect(readdirSync(destinations)).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual([
        "device-link.sqlite",
        "fifo-link.sqlite",
        "fifo.sqlite",
        "folder-link.sqlite",
        "folder.sqlite",
        "socket.sqlite",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds a stalled SQL check and the close of its connection", async () => {
    const server = await stalledPostgres();
    const dir = await tempDir();
    const source = `sqlite:${join(dir, "source.sqlite")}`;
    const opened = await openStores(source);
    await opened.stores.shares.create(sampleShare());
    await opened.close();
    const never = `sqlite:${join(dir, "never.sqlite")}`;
    // A query_timeout of the URL's own keeps pg from dropping the stuck connection.
    const kept = `${server.url}?query_timeout=86400000`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const [from, to, dropped] of [
        // The source's schema check, then the destination's emptiness check, stall.
        [server.url, never, true],
        [source, server.url, true],
        [kept, never, false],
        [source, kept, false],
      ] as const) {
        const queries = server.queries();
        let settled = false;
        const outcome = copyDatabase(from, to)
          .catch((caught: unknown) => caught)
          .finally(() => {
            settled = true;
          });
        while (server.queries() === queries) await new Promise((resolve) => setImmediate(resolve));
        const connections = server.connections();
        await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        // The copy's timeout, then pg's query_timeout: pg ends the stuck connection by itself.
        await vi.advanceTimersByTimeAsync(PG_QUERY_TIMEOUT_MS - OPERATION_TIMEOUT_MS + 1);
        const waiting = performance.now();
        while (
          !(settled && server.connections() < connections) &&
          performance.now() - waiting < 1_000
        )
          await new Promise((resolve) => setImmediate(resolve));
        expect(settled, `${from} to ${to} settled before the close allowance`).toBe(dropped);
        expect(server.connections()).toBe(dropped ? connections - 1 : connections);
        // Otherwise the close is still pending, and its own bound ends the wait.
        await vi.advanceTimersByTimeAsync(
          OPERATION_TIMEOUT_MS + CLOSE_TIMEOUT_MS - PG_QUERY_TIMEOUT_MS,
        );
        expect(settled).toBe(true);
        expect(await outcome).toMatchObject({ code: "ETIMEDOUT", destinationWritten: false });
        expect(await outcome).toBeInstanceOf(CopyFailureError);
      }
      expect(existsSync(join(dir, "never.sqlite"))).toBe(false);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });
});
