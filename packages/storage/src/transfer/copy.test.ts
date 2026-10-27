import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, defaultSettings, type ShareRecord } from "@gachipad/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStores } from "../memory.js";
import { type OpenedStores, openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import {
  CopyFailureError,
  CopyRefusedError,
  CopyVerificationError,
  copyDatabase,
  type MongoIdentity,
  sameMongoDatabase,
} from "./copy.js";
import { registerTransferBackend, transferBackend } from "./registry.js";
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
        yield Uint8Array.from({ length }, (_, index) => (offset + index) % 256);
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
  exportAll: (actual: TransferBackend, liveAt: Date, call: number) => AsyncIterable<TransferItem>,
) {
  const actual = transferBackend(stores);
  let calls = 0;
  registerTransferBackend(stores, {
    ...actual,
    exportAll: (liveAt) => exportAll(actual, liveAt, ++calls),
  });
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-unit-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
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
      async *exportAll(liveAt) {
        for await (const item of actual.exportAll(liveAt)) {
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
    wrapExport(destination, async function* (actual, liveAt) {
      const items: TransferItem[] = [];
      for await (const item of actual.exportAll(liveAt)) items.push(item);
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
    wrapExport(source, async function* (actual, liveAt, call) {
      // A TTL deletion after the copy read the share.
      if (call === 2) await source.shares.delete(shareId);
      yield* actual.exportAll(liveAt);
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
    wrapExport(source, async function* (actual, liveAt, call) {
      // A TTL deletion after the copy started but before both source reads.
      if (call === 1) await source.labs.delete("Lab00001");
      yield* actual.exportAll(liveAt);
    });
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
  });

  it("fails verification when an audit detail is not plain JSON", async () => {
    for (const detail of [{ value: Number.NaN }, { list: [1, undefined] }, { at: new Date(5) }]) {
      const source = createMemoryStores();
      await source.audit.append({
        at: new Date(1),
        actor: ownerId,
        ip: "192.0.2.1",
        action: "x",
        detail,
      });
      const url = `sqlite:${join(await tempDir(), "audit.sqlite")}`;
      await expect(
        copyDatabase("memory:", url, { openStores: openWithMemorySource(source) }),
      ).rejects.toBeInstanceOf(CopyVerificationError);
    }
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
    await expect(copyDatabase("memory:", url)).rejects.toBeInstanceOf(CopyRefusedError);
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
    const error = await copyDatabase("memory:", url).catch((caught: unknown) => caught);
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
});
