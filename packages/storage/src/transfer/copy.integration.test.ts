import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, type ShareRecord } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import { connectMongo } from "../mongo.js";
import { openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import { CopyRefusedError, copyDatabase } from "./copy.js";

const enabled = process.env.GACHIPAD_COPY_INTEGRATION === "1";
const mongoBase = process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/gp_copy_base";
type Backend = "mongodb" | "sqlite" | "postgresql" | "mysql" | "mariadb";
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
];
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

function databaseUrl(kind: Backend, name: string): string {
  if (kind === "sqlite") return `sqlite:/tmp/${name}.sqlite`;
  const base =
    kind === "mongodb"
      ? mongoBase
      : kind === "postgresql"
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
  if (kind === "mongodb") {
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
  if (kind === "mongodb") {
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
  if (kind === "mongodb") {
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

function runCli(from?: string, to?: string) {
  const env = { ...process.env };
  delete env.GACHIPAD_COPY_FROM;
  delete env.GACHIPAD_COPY_TO;
  if (from !== undefined) env.GACHIPAD_COPY_FROM = from;
  if (to !== undefined) env.GACHIPAD_COPY_TO = to;
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
    it(`${pair.from} to ${pair.to}${pair.cli ? " through the API CLI" : ""}`, async () => {
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
    }, 300_000);
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
        expect(run.output).not.toContain("cli-secret");
        expect(run.output).not.toContain("/tmp/");
      }
    } finally {
      await dropDatabase("sqlite", `${name}_filled`, filled);
      await dropDatabase("sqlite", `${name}_empty`, empty);
      await dropDatabase("mongodb", `${name}_mongo`, mongo);
    }
  }, 120_000);
});
