import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultSettings, type ShareRecord } from "@gachipad/shared";
import type { CommandStartedEvent } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { COLLECTIONS, connectMongo, createMongoStores, UPLOADS_BUCKET } from "../mongo.js";
import { openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import { CopyRefusedError, copyDatabase } from "./copy.js";
import { transferBackend } from "./registry.js";

const enabled = process.env.GACHIPAD_COPY_INTEGRATION === "1";
const mongoBase = process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/gp_copy_base";
// A replica set seed list and a direct connection to one of its secondaries, when available.
const replicaSetBase = process.env.TEST_MONGO_RS_URL;
const secondaryBase = process.env.TEST_MONGO_SECONDARY_URL;
type Backend = "mongodb" | "mongors" | "sqlite" | "postgresql" | "mysql" | "mariadb";
type Pair = { from: Backend; to: Backend; cli?: boolean };
const pairs: Pair[] = [
  { from: "mongodb", to: "sqlite", cli: true },
  { from: "mongodb", to: "postgresql" },
  { from: "mongodb", to: "mariadb" },
  { from: "mongodb", to: "mysql" },
  { from: "sqlite", to: "postgresql" },
  { from: "postgresql", to: "mongodb" },
  { from: "mariadb", to: "sqlite" },
  { from: "postgresql", to: "mysql" },
  { from: "mongors", to: "postgresql", cli: true },
  { from: "sqlite", to: "mongors" },
];
const isMongo = (kind: Backend) => kind === "mongodb" || kind === "mongors";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const ownerId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";
const labelClientId = "44444444-4444-4444-8444-444444444444";
const shareId = "Copy0001";
const day = 86_400_000;
const client = (prefix: string, index: number) =>
  `${prefix}${index.toString(16).padStart(7, "0")}-1111-4111-8111-111111111111`;
// More than one page (128) of each kind, with ids whose binary and linguistic orders differ.
const extraShareIds = Array.from(
  { length: 150 },
  (_, index) => `${"aBcD"[index % 4]}${String(index).padStart(7, "0")}`,
);
const labelClients = [client("c", 1), client("c", 2), client("c", 3)];
const updateSeqs = [
  ...Array.from({ length: 140 }, (_, index) => index + 1),
  ...Array.from({ length: 140 }, (_, index) => index + 150),
];
const largeSnapshotBytes = 5 * 1024 * 1024 + 3;
const expectedCopyCounts = {
  shares: 151,
  updates: 430,
  snapshots: 3,
  uploads: 2,
  labs: 2,
  labels: 151,
  settings: 1,
  audit: 140,
};

function shareFixture(): ShareRecord {
  const at = new Date("2026-10-20T08:09:10.123Z");
  return {
    id: shareId,
    title: "복사 확인 — Unicode 日本語",
    language: "typescript",
    ownerId,
    createdAt: at,
    updatedAt: new Date(at.getTime() + 1000),
    lastActiveAt: new Date(at.getTime() + 2000),
    expiresAt: null,
    saved: true,
    savedBy: Array.from({ length: 300 }, (_, index) => client("a", index)),
    access: {
      default: "edit",
      editKey: "fixture-key-not-a-secret",
      generation: "copy-generation",
      pinHash: "scrypt$fixture-salt$fixture-hash-not-a-secret",
      requireApproval: true,
      nearby: false,
      allowParticipantRename: true,
      allowParticipantFiles: true,
      allowParticipantLanguage: false,
    },
    bans: Array.from({ length: 150 }, (_, index) => client("b", index)),
    joinCode: "123456",
    locked: true,
    sizeBytes: 256,
    preview: "행복な preview",
    previewAt: new Date(at.getTime() + 3000),
  };
}

const updateBytes = (seq: number) =>
  seq === 1
    ? Uint8Array.from({ length: 256 }, (_, index) => index)
    : Uint8Array.from({ length: 64 + (seq % 50) }, (_, index) => (seq * 7 + index) % 256);

/** Selects a database in a MongoDB connection string without URL parsing: it may list hosts. */
function mongoDatabaseUrl(base: string, name: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(base);
  if (!match) throw new Error("Unsupported MongoDB test URL");
  return `${match[1]}/${name}${match[2] ?? ""}`;
}

function databaseUrl(kind: Backend, name: string): string {
  if (kind === "sqlite") return `sqlite:/tmp/${name}.sqlite`;
  if (kind === "mongodb") return mongoDatabaseUrl(mongoBase, name);
  if (kind === "mongors") {
    if (!replicaSetBase) throw new Error("Missing integration URL for mongors");
    return mongoDatabaseUrl(replicaSetBase, name);
  }
  const base =
    kind === "postgresql"
      ? process.env.TEST_POSTGRES_URL
      : kind === "mysql"
        ? process.env.TEST_MYSQL_URL
        : process.env.TEST_MARIADB_URL;
  if (!base) throw new Error(`Missing integration URL for ${kind}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  if (kind === "mariadb") url.protocol = "mariadb:";
  return url.toString();
}

async function prepareDatabase(kind: Backend, name: string, url: string): Promise<void> {
  if (kind === "sqlite") {
    await rm(`/tmp/${name}.sqlite`, { force: true });
    return;
  }
  if (isMongo(kind)) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(url);
    await client.connect();
    try {
      await client.db(name).dropDatabase();
    } finally {
      await client.close();
    }
    return;
  }
  const adminUrl = new URL(url);
  if (kind === "postgresql") {
    const { Client } = await import("pg");
    adminUrl.pathname = "/postgres";
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      // A linguistic collation ("a..." before "B..."), unlike MongoDB's and MySQL's binary order.
      await client.query(
        `CREATE DATABASE "${name}" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`,
      );
    } finally {
      await client.end();
    }
    return;
  }
  const mysql = await import("mysql2/promise");
  adminUrl.pathname = "/";
  const pool = mysql.createPool(adminUrl.toString().replace(/^mariadb:/, "mysql:"));
  try {
    await pool.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await pool.query(`CREATE DATABASE \`${name}\``);
  } finally {
    await pool.end();
  }
}

async function dropDatabase(kind: Backend, name: string, url: string): Promise<void> {
  if (kind === "sqlite") {
    await Promise.all([
      rm(`/tmp/${name}.sqlite`, { force: true }),
      rm(`/tmp/${name}.sqlite-wal`, { force: true }),
      rm(`/tmp/${name}.sqlite-shm`, { force: true }),
    ]);
    return;
  }
  if (isMongo(kind)) {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(url);
    await client.connect();
    try {
      await client.db(name).dropDatabase();
    } finally {
      await client.close();
    }
    return;
  }
  const adminUrl = new URL(url);
  if (kind === "postgresql") {
    const { Client } = await import("pg");
    adminUrl.pathname = "/postgres";
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
    return;
  }
  const mysql = await import("mysql2/promise");
  adminUrl.pathname = "/";
  const pool = mysql.createPool(adminUrl.toString().replace(/^mariadb:/, "mysql:"));
  try {
    await pool.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await pool.end();
  }
}

async function seed(stores: Awaited<ReturnType<typeof openStores>>["stores"]) {
  const now = Date.now();
  const share = shareFixture();
  await stores.shares.create(share);
  // Gaps in the SQL position column; the copy keeps list order, not positions.
  for (const removed of [client("a", 5), client("a", 200)])
    await stores.shares.removeSaved(shareId, removed, new Date(now + 30 * day));
  for (let index = 0; index < updateSeqs.length; index += 70)
    await stores.updates.append(
      shareId,
      updateSeqs.slice(index, index + 70).map((seq) => ({ seq, data: updateBytes(seq) })),
      new Date(Date.parse("2026-10-21T10:11:12.456Z") + index),
    );
  await stores.snapshots.put({
    shareId,
    seq: 289,
    at: new Date("2026-10-21T10:11:13.456Z"),
    kind: "compact",
    state: updateBytes(1),
  });
  await stores.snapshots.put({
    shareId,
    seq: 2,
    at: new Date("2026-10-21T10:11:14.456Z"),
    kind: "history",
    state: updateBytes(1),
  });
  await stores.snapshots.put({
    shareId,
    seq: 3,
    at: new Date("2026-10-21T10:11:15.456Z"),
    kind: "history",
    state: Uint8Array.from({ length: largeSnapshotBytes }, (_, index) => (index * 31) % 251),
  });

  for (const [index, id] of [...extraShareIds].reverse().entries()) {
    await stores.shares.create({
      ...shareFixture(),
      id,
      title: `share ${id}`,
      saved: false,
      savedBy: [],
      bans: [],
      access: { ...shareFixture().access, pinHash: null },
      expiresAt: index % 2 ? null : new Date(now + 30 * day),
    });
    await stores.updates.append(id, [{ seq: 1, data: updateBytes(index + 2) }], new Date(now));
  }
  for (const [index, clientId] of labelClients.entries())
    for (const id of extraShareIds.slice(index * 50, index * 50 + 50))
      await stores.labels.set(clientId, id, { folder: `폴더 ${index}`, tags: [id] }, new Date(now));
  await stores.labels.set(
    labelClientId,
    shareId,
    { folder: "수업 / A", tags: ["문서", "共有"] },
    new Date("2026-10-22T09:08:07.006Z"),
  );

  const uploadSize = 3 * 1024 * 1024 + 71;
  const upload = await stores.files.putStream({
    name: "copy-fixture.bin",
    contentType: "application/octet-stream",
    ownerId,
    shareId,
    expiresAt: new Date("2099-01-02T03:04:05.678Z"),
    stream: (async function* () {
      for (let offset = 0; offset < uploadSize; offset += 333 * 1024) {
        const length = Math.min(333 * 1024, uploadSize - offset);
        yield Uint8Array.from({ length }, (_, index) => (offset + index) % 256);
      }
    })(),
  });
  const loose = await stores.files.put({
    name: "loose.txt",
    contentType: null,
    ownerId,
    expiresAt: new Date("2099-01-02T03:04:05.678Z"),
    data: updateBytes(3),
  });

  await stores.labs.create({
    id: "LabCopy1",
    title: "수업 — 日本語",
    ownerId,
    joinCode: "654321",
    templateShareId: shareId,
    locked: false,
    students: [
      {
        clientId: studentId,
        name: "수강생",
        shareId: "StudCpy1",
        joinedAt: new Date("2026-10-19T12:13:14.015Z"),
      },
    ],
    createdAt: new Date("2026-10-18T11:12:13.014Z"),
    expiresAt: new Date("2099-10-18T11:12:13.014Z"),
  });
  await stores.labs.create({
    id: "labCopy2",
    title: "second",
    ownerId,
    joinCode: "654322",
    templateShareId: null,
    locked: true,
    students: [],
    createdAt: new Date("2026-10-18T11:12:13.014Z"),
    expiresAt: new Date("2099-10-18T11:12:13.014Z"),
  });
  await stores.settings.put({
    ...defaultSettings(),
    guestAllowed: false,
    contact: "ops@example.invalid",
  });
  for (let index = 0; index < expectedCopyCounts.audit; index++)
    await stores.audit.append({
      at: new Date(Date.parse("2026-10-23T06:05:04.003Z") + index),
      actor: ownerId,
      ip: "192.0.2.3",
      action: "share.saved",
      shareId,
      detail: { label: "저장됨", nested: { value: index, list: [true, null, 1.5] } },
    });

  // Already expired, or belonging to an expired or missing share: none of this is copied. On
  // MongoDB the TTL index may also remove the expired share and lab before the copy starts.
  await stores.shares.create({
    ...shareFixture(),
    id: "Expired1",
    savedBy: [],
    bans: [],
    saved: false,
    expiresAt: new Date(now - day),
  });
  await stores.labs.create({
    id: "LabOld01",
    title: "expired",
    ownerId,
    joinCode: "111111",
    templateShareId: null,
    locked: false,
    students: [],
    createdAt: new Date(now - 2 * day),
    expiresAt: new Date(now - day),
  });
  const skippedUploads: string[] = [];
  for (const garbage of ["Expired1", "Missing1"]) {
    await stores.updates.append(garbage, [{ seq: 1, data: updateBytes(1) }], new Date(now));
    await stores.snapshots.put({
      shareId: garbage,
      seq: 1,
      at: new Date(now),
      kind: "compact",
      state: updateBytes(1),
    });
    await stores.labels.set(labelClientId, garbage, { folder: null, tags: ["x"] }, new Date(now));
    const attached = await stores.files.put({
      name: `${garbage}.txt`,
      contentType: null,
      ownerId,
      shareId: garbage,
      expiresAt: new Date(now + day),
      data: updateBytes(2),
    });
    skippedUploads.push(attached.id);
  }
  const expired = await stores.files.put({
    name: "expired.txt",
    contentType: null,
    ownerId,
    expiresAt: new Date(now - day),
    data: updateBytes(4),
  });
  skippedUploads.push(expired.id);
  return {
    upload,
    uploadSize,
    loose,
    skippedUploads,
    uploadBytes: uploadSize + loose.size,
  };
}

async function streamHash(
  stream: NodeJS.ReadableStream,
): Promise<{ size: number; digest: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const part of stream) {
    const bytes = part as Uint8Array;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { size, digest: hash.digest("hex") };
}

async function sameUpload(
  source: Awaited<ReturnType<typeof openStores>>["stores"],
  destination: Awaited<ReturnType<typeof openStores>>["stores"],
  id: string,
  size: number,
) {
  const sourceDownload = await source.files.openDownload(id);
  const destinationDownload = await destination.files.openDownload(id);
  if (!sourceDownload || !destinationDownload) throw new Error("The upload was not copied");
  expect(destinationDownload.meta).toEqual(sourceDownload.meta);
  const [sourceBytes, destinationBytes] = await Promise.all([
    streamHash(sourceDownload.stream),
    streamHash(destinationDownload.stream),
  ]);
  expect(sourceBytes.size).toBe(size);
  expect(destinationBytes).toEqual(sourceBytes);
}

const snapshotHash = (snapshot: { state: Uint8Array } | null) =>
  snapshot && {
    ...snapshot,
    state: createHash("sha256").update(snapshot.state).digest("hex"),
  };

async function compare(
  source: Awaited<ReturnType<typeof openStores>>["stores"],
  destination: Awaited<ReturnType<typeof openStores>>["stores"],
  fixture: Awaited<ReturnType<typeof seed>>,
) {
  const copied = await destination.shares.get(shareId);
  expect(copied).toEqual(await source.shares.get(shareId));
  expect(copied?.savedBy).toHaveLength(298);
  expect(copied?.bans).toHaveLength(150);
  expect(copied?.access.pinHash).toBe(shareFixture().access.pinHash);
  for (const id of extraShareIds) {
    expect(await destination.shares.get(id)).toEqual(await source.shares.get(id));
    expect(await destination.updates.read(id, 0)).toEqual(await source.updates.read(id, 0));
  }
  const updates = await destination.updates.read(shareId, 0);
  expect(updates.map((update) => update.seq)).toEqual(updateSeqs);
  expect(updates).toEqual(await source.updates.read(shareId, 0));
  expect(await destination.updates.lastSeq(shareId)).toBe(289);
  for (const [kind, seq] of [
    ["compact", 289],
    ["history", 2],
    ["history", 3],
  ] as const)
    expect(snapshotHash(await destination.snapshots.get(shareId, kind, seq))).toEqual(
      snapshotHash(await source.snapshots.get(shareId, kind, seq)),
    );
  expect((await destination.snapshots.get(shareId, "history", 3))?.state.byteLength).toBe(
    largeSnapshotBytes,
  );
  await sameUpload(source, destination, fixture.upload.id, fixture.uploadSize);
  await sameUpload(source, destination, fixture.loose.id, fixture.loose.size);
  for (const id of ["LabCopy1", "labCopy2"])
    expect(await destination.labs.get(id)).toEqual(await source.labs.get(id));
  for (const [index, clientId] of labelClients.entries())
    for (const id of extraShareIds.slice(index * 50, index * 50 + 50))
      expect(await destination.labels.get(clientId, id)).toEqual(
        await source.labels.get(clientId, id),
      );
  expect(await destination.labels.get(labelClientId, shareId)).toEqual(
    await source.labels.get(labelClientId, shareId),
  );
  expect(await destination.settings.get()).toEqual(await source.settings.get());
  expect(await destination.audit.list({ limit: 500 })).toEqual(
    await source.audit.list({ limit: 500 }),
  );

  expect(await destination.shares.get("Expired1")).toBeNull();
  expect(await destination.labs.get("LabOld01")).toBeNull();
  for (const garbage of ["Expired1", "Missing1"]) {
    expect(await destination.updates.read(garbage, 0)).toEqual([]);
    expect(await destination.snapshots.latest(garbage, "compact")).toBeNull();
    expect(await destination.labels.get(labelClientId, garbage)).toBeNull();
  }
  for (const id of fixture.skippedUploads) expect(await destination.files.meta(id)).toBeNull();
}

async function assertUploadCounter(kind: Backend, url: string, expected: number): Promise<void> {
  if (isMongo(kind)) {
    const connection = await connectMongo(url);
    try {
      const row = await connection.db
        .collection<{ _id: string; bytes: number }>("storage_quotas")
        .findOne({ _id: "uploads" });
      expect(row?.bytes).toBe(expected);
    } finally {
      await connection.close();
    }
    return;
  }
  const driver = await openSqlDriver(url);
  try {
    const [row] = await driver.all<{ used_bytes: number | string }>(
      "SELECT used_bytes FROM upload_capacity WHERE id=1",
    );
    expect(Number(row?.used_bytes)).toBe(expected);
  } finally {
    await driver.close();
  }
}

const margin = 15 * 60_000;
const farFuture = new Date("2099-01-02T03:04:05.678Z");

/**
 * Records on both sides of the cutoff (t0 + 15 minutes): shares, labs and uploads expiring 1 ms
 * before, at and 1 ms after it, a share without expiry, and child records of every share.
 */
async function seedBoundary(stores: Awaited<ReturnType<typeof openStores>>["stores"], t0: number) {
  const at = (offset: number) => new Date(t0 + margin + offset);
  const uploads = new Map<string, string>();
  const putUpload = async (name: string, expiresAt: Date, shareId?: string) => {
    const meta = await stores.files.put({
      name,
      contentType: null,
      ownerId,
      ...(shareId ? { shareId } : {}),
      expiresAt,
      data: updateBytes(name.length),
    });
    uploads.set(name, meta.id);
  };
  const shares = { ShBelow1: at(-1), ShEqual1: at(0), ShAbove1: at(1), ShNull01: null };
  for (const [id, expiresAt] of Object.entries(shares)) {
    await stores.shares.create({
      ...shareFixture(),
      id,
      saved: expiresAt === null,
      savedBy: [],
      bans: [],
      expiresAt,
    });
    await stores.updates.append(id, [{ seq: 1, data: updateBytes(2) }], new Date(t0));
    await stores.labels.set(labelClientId, id, { folder: null, tags: [] }, new Date(t0));
    await putUpload(`${id}.bin`, farFuture, id);
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
    await stores.labs.create({
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
  return uploads;
}

async function compareBoundary(
  source: Awaited<ReturnType<typeof openStores>>["stores"],
  destination: Awaited<ReturnType<typeof openStores>>["stores"],
  uploads: Map<string, string>,
) {
  for (const [id, copied] of [
    ["ShBelow1", false],
    ["ShEqual1", false],
    ["ShAbove1", true],
    ["ShNull01", true],
  ] as const) {
    expect(await destination.shares.get(id)).toEqual(copied ? await source.shares.get(id) : null);
    expect(await destination.updates.read(id, 0)).toEqual(
      copied ? await source.updates.read(id, 0) : [],
    );
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
  for (const [name, id] of uploads) {
    const meta = await destination.files.meta(id);
    if (!meta) continue;
    expect(meta).toEqual(await source.files.meta(id));
    copiedUploads.push(name);
  }
  expect(copiedUploads.sort()).toEqual([
    "ShAbove1.bin",
    "ShNull01.bin",
    "loose-above",
    "own-above",
  ]);
}

/** A module for the CLI's NODE_OPTIONS, written to a temporary directory. */
async function preloadModule(source: string): Promise<{ url: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-preload-"));
  const file = join(dir, "preload.mjs");
  await writeFile(file, source);
  return { url: pathToFileURL(file).href, dir };
}

function runCli(from?: string, to?: string, preload?: string) {
  const env = { ...process.env };
  delete env.GACHIPAD_COPY_FROM;
  delete env.GACHIPAD_COPY_TO;
  if (from !== undefined) env.GACHIPAD_COPY_FROM = from;
  if (to !== undefined) env.GACHIPAD_COPY_TO = to;
  // A module loaded before the CLI, to move its clocks.
  if (preload) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${preload}`.trim();
  // As in the API image: npm keeps the CLI's exit code (pnpm --filter reports any failure as 1).
  const result = spawnSync("npm", ["run", "--silent", "copy-db"], {
    cwd: resolve(repoRoot, "apps/api"),
    encoding: "utf8",
    env,
  });
  return { status: result.status, output: result.stdout };
}

describe.skipIf(!enabled)("real backend database transfer", () => {
  for (const [index, pair] of pairs.entries()) {
    const needsReplicaSet = pair.from === "mongors" || pair.to === "mongors";
    it.skipIf(needsReplicaSet && !replicaSetBase)(
      `${pair.from} to ${pair.to}${pair.cli ? " through the API CLI" : ""}`,
      async () => {
        const prefix = `gp_copy_${pair.from}_${pair.to}_${index}`;
        const sourceName = `${prefix}_src`;
        const destinationName = `${prefix}_dst`;
        const sourceUrl = databaseUrl(pair.from, sourceName);
        const destinationUrl = databaseUrl(pair.to, destinationName);
        let sourceDb: Awaited<ReturnType<typeof openStores>> | undefined;
        let destinationDb: Awaited<ReturnType<typeof openStores>> | undefined;
        try {
          await prepareDatabase(pair.from, sourceName, sourceUrl);
          await prepareDatabase(pair.to, destinationName, destinationUrl);
          sourceDb = await openStores(sourceUrl);
          const fixture = await seed(sourceDb.stores);
          await sourceDb.close();
          sourceDb = undefined;

          if (pair.cli) {
            const { status, output } = runCli(sourceUrl, destinationUrl);
            console.log(output.trim());
            expect(status).toBe(0);
            expect(output).toContain("Result: success");
            for (const [kind, count] of Object.entries(expectedCopyCounts))
              expect(output).toContain(`${kind}: ${count}\n`);
          } else {
            const result = await copyDatabase(sourceUrl, destinationUrl);
            expect(result.counts).toEqual(expectedCopyCounts);
          }

          sourceDb = await openStores(sourceUrl);
          destinationDb = await openStores(destinationUrl);
          await compare(sourceDb.stores, destinationDb.stores, fixture);
          await assertUploadCounter(pair.to, destinationUrl, fixture.uploadBytes);
        } finally {
          await sourceDb?.close().catch(() => undefined);
          await destinationDb?.close().catch(() => undefined);
          await dropDatabase(pair.from, sourceName, sourceUrl);
          await dropDatabase(pair.to, destinationName, destinationUrl);
        }
      },
      300_000,
    );
  }

  it("refuses the same MongoDB database under another connection string", async () => {
    const name = "gp_copy_same_mongo";
    const url = databaseUrl("mongodb", name);
    const alias = `${url}${url.includes("?") ? "&" : "?"}appName=gp-copy-alias`;
    try {
      await prepareDatabase("mongodb", name, url);
      const opened = await openStores(url);
      await opened.stores.settings.put({ ...defaultSettings(), contact: "same@example.invalid" });
      await opened.close();
      await expect(copyDatabase(url, alias)).rejects.toThrow(
        new CopyRefusedError("Source and destination are the same"),
      );
    } finally {
      await dropDatabase("mongodb", name, url);
    }
  }, 60_000);

  it("refuses a PostgreSQL destination whose search_path reaches a non-empty table", async () => {
    const name = "gp_copy_search_path";
    const url = databaseUrl("postgresql", name);
    const source = `sqlite:/tmp/${name}_src.sqlite`;
    try {
      await prepareDatabase("postgresql", name, url);
      await prepareDatabase("sqlite", `${name}_src`, source);
      const opened = await openStores(url);
      await opened.stores.settings.put({ ...defaultSettings(), contact: "kept@example.invalid" });
      await opened.close();
      // Migration metadata in the first schema, the existing tables only in public.
      const driver = await openSqlDriver(url);
      try {
        await driver.run("CREATE SCHEMA app");
        await driver.run("CREATE TABLE app.schema_version AS TABLE public.schema_version");
      } finally {
        await driver.close();
      }
      const searchPathUrl = `${url}?options=${encodeURIComponent("-c search_path=app,public")}`;
      await expect(copyDatabase(source, searchPathUrl)).rejects.toThrow(
        new CopyRefusedError("Destination is not empty"),
      );
      const check = await openStores(url);
      expect((await check.stores.settings.get()).contact).toBe("kept@example.invalid");
      await check.close();
    } finally {
      await dropDatabase("postgresql", name, url);
      await dropDatabase("sqlite", `${name}_src`, source);
    }
  }, 60_000);

  it("exits 2 for refusals and 1 for failures without printing URLs", async () => {
    const name = "gp_copy_cli_codes";
    const filled = `sqlite:/tmp/${name}_filled.sqlite`;
    const empty = `sqlite:/tmp/${name}_empty.sqlite`;
    const mongo = databaseUrl("mongodb", `${name}_mongo`);
    try {
      await prepareDatabase("sqlite", `${name}_filled`, filled);
      await prepareDatabase("sqlite", `${name}_empty`, empty);
      const opened = await openStores(filled);
      await opened.stores.settings.put({ ...defaultSettings(), contact: "cli@example.invalid" });
      await opened.close();

      const cases = [
        [
          undefined,
          undefined,
          2,
          "Result: refused (GACHIPAD_COPY_FROM and GACHIPAD_COPY_TO are required).",
        ],
        [
          filled,
          "couchdb://user:cli-secret@localhost/db",
          2,
          "Result: refused (Unsupported database URL scheme).",
        ],
        [filled, filled, 2, "Result: refused (Source and destination are the same)."],
        [empty, filled, 2, "Result: refused (Destination is not empty)."],
        [
          mongo,
          `${mongo}${mongo.includes("?") ? "&" : "?"}appName=gp-copy-cli`,
          2,
          "Result: refused (Source and destination are the same).",
        ],
        [
          filled,
          "sqlite:/tmp/gp_copy_cli_missing_dir/cli-secret.sqlite",
          1,
          "Result: failed (SQLITE_CANTOPEN); drop the destination before retrying.",
        ],
        [
          filled,
          "mongodb://copy:cli-secret@localhost/gp?authMechanism=NOT-A-MECHANISM",
          1,
          "Result: failed; drop the destination before retrying.",
        ],
      ] as const;
      for (const [from, to, status, result] of cases) {
        const run = runCli(from, to);
        expect(run.output.trim().split("\n").at(-1)).toBe(result);
        expect(run.status).toBe(status);
        expect(run.output).toContain("Source must be quiescent");
        expect(run.output).toContain("records that expired or expire within 15 minutes");
        expect(run.output).not.toContain("cli-secret");
        expect(run.output).not.toContain("/tmp/");
      }
    } finally {
      await dropDatabase("sqlite", `${name}_filled`, filled);
      await dropDatabase("sqlite", `${name}_empty`, empty);
      await dropDatabase("mongodb", `${name}_mongo`, mongo);
    }
  }, 120_000);

  it("refuses MongoDB clocks more than 2 minutes off through the CLI", async () => {
    const name = "gp_copy_cli_clock";
    const mongo = databaseUrl("mongodb", name);
    const sqlite = `sqlite:/tmp/${name}.sqlite`;
    const sqliteSource = `sqlite:/tmp/${name}_src.sqlite`;
    const mongoDestination = databaseUrl("mongodb", `${name}_dst`);
    const refused =
      "Result: refused (MongoDB server clock differs from this host by more than 2 minutes).";
    // This host's clock runs 3 minutes ahead of the servers'.
    const preload = await preloadModule(
      "const now = Date.now.bind(Date);\nDate.now = () => now() + 3 * 60_000;\n",
    );
    try {
      await prepareDatabase("sqlite", name, sqlite);
      await prepareDatabase("sqlite", `${name}_src`, sqliteSource);
      await prepareDatabase("mongodb", name, mongo);
      await prepareDatabase("mongodb", `${name}_dst`, mongoDestination);
      for (const url of [mongo, sqliteSource]) {
        const opened = await openStores(url);
        await opened.stores.settings.put({
          ...defaultSettings(),
          contact: "clock@example.invalid",
        });
        await opened.close();
      }
      // MongoDB source: refused before the destination is opened.
      const fromMongo = runCli(mongo, sqlite, preload.url);
      expect(fromMongo.output.trim().split("\n").at(-1)).toBe(refused);
      expect(fromMongo.status).toBe(2);
      expect(existsSync(`/tmp/${name}.sqlite`)).toBe(false);
      // MongoDB destination: refused before any index or record is written.
      const toMongo = runCli(sqliteSource, mongoDestination, preload.url);
      expect(toMongo.output.trim().split("\n").at(-1)).toBe(refused);
      expect(toMongo.status).toBe(2);
      const connection = await connectMongo(mongoDestination);
      try {
        expect(await connection.db.listCollections().toArray()).toEqual([]);
      } finally {
        await connection.close();
      }
    } finally {
      await rm(preload.dir, { recursive: true, force: true });
      await dropDatabase("sqlite", name, sqlite);
      await dropDatabase("sqlite", `${name}_src`, sqliteSource);
      await dropDatabase("mongodb", name, mongo);
      await dropDatabase("mongodb", `${name}_dst`, mongoDestination);
    }
  }, 120_000);

  it("fails a copy that takes longer than 10 minutes through the CLI", async () => {
    const name = "gp_copy_cli_deadline";
    const destination = `sqlite:/tmp/${name}_dst.sqlite`;
    // The copier's monotonic clock jumps 10 minutes after its start. Only calls made by copy.ts
    // itself (the caller frame) move; driver calls further down keep the real clock.
    const preload = await preloadModule(
      [
        "const now = performance.now.bind(performance);",
        "let started = false;",
        "performance.now = () => {",
        '  if (!new Error().stack?.split("\\n")[2]?.includes("transfer/copy.ts")) return now();',
        "  if (!started) {",
        "    started = true;",
        "    return now();",
        "  }",
        "  return now() + 10 * 60_000;",
        "};",
        "",
      ].join("\n"),
    );
    const sources = [
      ["sqlite", `sqlite:/tmp/${name}_src.sqlite`],
      ["mongodb", databaseUrl("mongodb", `${name}_src`)],
    ] as const;
    try {
      for (const [kind, source] of sources) {
        await prepareDatabase(kind, `${name}_src`, source);
        await prepareDatabase("sqlite", `${name}_dst`, destination);
        const opened = await openStores(source);
        await opened.stores.settings.put({ ...defaultSettings(), contact: "slow@example.invalid" });
        await opened.close();
        const run = runCli(source, destination, preload.url);
        expect(run.output.trim().split("\n").at(-1)).toBe(
          "Result: failed (took longer than 10 minutes); drop the destination before retrying.",
        );
        expect(run.status).toBe(1);
        expect(run.output).not.toContain("/tmp/");
        // The destination is left for the operator to drop.
        expect(existsSync(`/tmp/${name}_dst.sqlite`)).toBe(true);
      }
    } finally {
      await rm(preload.dir, { recursive: true, force: true });
      for (const [kind, source] of sources) await dropDatabase(kind, `${name}_src`, source);
      await dropDatabase("sqlite", `${name}_dst`, destination);
    }
  }, 120_000);

  for (const [from, to] of [
    ["mongodb", "sqlite"],
    ["postgresql", "mongodb"],
    ["mariadb", "mysql"],
  ] as const)
    it(`copies exactly the records expiring after the cutoff: ${from} to ${to}`, async () => {
      const sourceName = `gp_copy_cutoff_${from}_src`;
      const destinationName = `gp_copy_cutoff_${to}_dst`;
      const sourceUrl = databaseUrl(from, sourceName);
      const destinationUrl = databaseUrl(to, destinationName);
      const t0 = Date.now();
      let sourceDb: Awaited<ReturnType<typeof openStores>> | undefined;
      let destinationDb: Awaited<ReturnType<typeof openStores>> | undefined;
      try {
        await prepareDatabase(from, sourceName, sourceUrl);
        await prepareDatabase(to, destinationName, destinationUrl);
        sourceDb = await openStores(sourceUrl);
        const uploads = await seedBoundary(sourceDb.stores, t0);
        await sourceDb.close();
        sourceDb = undefined;
        // The copy takes t0 as its start, so its cutoff is exactly t0 + 15 minutes.
        vi.spyOn(Date, "now").mockReturnValue(t0);
        const result = await copyDatabase(sourceUrl, destinationUrl);
        vi.restoreAllMocks();
        expect(result.counts).toMatchObject({
          shares: 2,
          updates: 2,
          labels: 2,
          labs: 1,
          uploads: 4,
        });
        sourceDb = await openStores(sourceUrl);
        destinationDb = await openStores(destinationUrl);
        await compareBoundary(sourceDb.stores, destinationDb.stores, uploads);
      } finally {
        vi.restoreAllMocks();
        await sourceDb?.close().catch(() => undefined);
        await destinationDb?.close().catch(() => undefined);
        await dropDatabase(from, sourceName, sourceUrl);
        await dropDatabase(to, destinationName, destinationUrl);
      }
    }, 120_000);

  it("reads every MongoDB source record from the primary with majority read concern", async () => {
    // A replica set shows the routing; a standalone server still shows the read concern.
    const kind: Backend = replicaSetBase ? "mongors" : "mongodb";
    const name = "gp_copy_read_options";
    const url = databaseUrl(kind, name);
    const { MongoClient } = await import("mongodb");
    // The connection string asks for the opposite: a secondary and local read concern.
    const client = new MongoClient(
      `${url}${url.includes("?") ? "&" : "?"}readPreference=secondaryPreferred&readConcernLevel=local`,
      { monitorCommands: true },
    );
    const reads: CommandStartedEvent[] = [];
    client.on("commandStarted", (event) => {
      if (["find", "aggregate", "count", "distinct"].includes(event.commandName)) reads.push(event);
    });
    try {
      await prepareDatabase(kind, name, url);
      const opened = await openStores(url);
      await seed(opened.stores);
      await opened.close();
      await client.connect();
      const backend = transferBackend(createMongoStores(client.db()));
      const cutoff = new Date(Date.now() + margin);
      await backend.countLive(cutoff);
      for await (const item of backend.exportAll(cutoff))
        if (item.kind === "uploads") for await (const _chunk of item.chunks);
      await backend.uploadCounter();
      const collections = new Set(reads.map((event) => event.command[event.commandName]));
      // Every collection the copy reads, including GridFS metadata and chunks.
      for (const collection of [
        ...Object.values(COLLECTIONS),
        `${UPLOADS_BUCKET}.files`,
        `${UPLOADS_BUCKET}.chunks`,
        "storage_quotas",
      ])
        expect(collections).toContain(collection);
      // Events carry resolved addresses; the test members differ only by port.
      const hello = await client.db("admin").command({ hello: 1 }, { readPreference: "primary" });
      const primaryPort = `:${String(hello.primary).split(":").at(-1)}`;
      for (const event of reads) {
        expect(event.command.readConcern).toEqual({ level: "majority" });
        if (kind === "mongors") expect(event.address.endsWith(primaryPort)).toBe(true);
      }
    } finally {
      await client.close();
      await dropDatabase(kind, name, url);
    }
  }, 120_000);

  it.skipIf(!replicaSetBase || !secondaryBase)(
    "refuses a secondary source and a replica set member under another name",
    async () => {
      const name = "gp_copy_rs_identity";
      const primary = databaseUrl("mongors", name);
      const secondary = mongoDatabaseUrl(secondaryBase ?? "", name);
      const empty = `sqlite:/tmp/${name}.sqlite`;
      try {
        await prepareDatabase("mongors", name, primary);
        await prepareDatabase("sqlite", name, empty);
        const opened = await openStores(primary);
        await opened.stores.settings.put({ ...defaultSettings(), contact: "rs@example.invalid" });
        await opened.close();
        // A direct connection to the secondary would read whatever it has replicated so far.
        const run = runCli(secondary, empty);
        expect(run.output.trim().split("\n").at(-1)).toBe(
          "Result: refused (MongoDB source is not the primary).",
        );
        expect(run.status).toBe(2);
        expect(existsSync(`/tmp/${name}.sqlite`)).toBe(false);
        // The secondary answers with another process id, but the same set and members.
        await expect(copyDatabase(primary, secondary)).rejects.toThrow(
          new CopyRefusedError("Source and destination are the same"),
        );
        const check = await openStores(primary);
        expect((await check.stores.settings.get()).contact).toBe("rs@example.invalid");
        await check.close();
      } finally {
        await dropDatabase("sqlite", name, empty);
        await dropDatabase("mongors", name, primary);
      }
    },
    120_000,
  );
});
