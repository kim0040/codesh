import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, type ShareRecord } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import { connectMongo } from "../mongo.js";
import { openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import { copyDatabase } from "./copy.js";

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
];

const ownerId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";
const bannedId = "33333333-3333-4333-8333-333333333333";
const labelClientId = "44444444-4444-4444-8444-444444444444";
const shareId = "Copy0001";
const expectedCopyCounts = {
  shares: 1,
  updates: 1,
  snapshots: 2,
  uploads: 1,
  labs: 1,
  labels: 1,
  settings: 1,
  audit: 1,
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
    savedBy: [studentId],
    access: {
      default: "edit",
      editKey: "fixture-key-not-a-secret",
      generation: "copy-generation",
      pinHash: null,
      requireApproval: true,
      nearby: false,
      allowParticipantRename: true,
      allowParticipantFiles: true,
      allowParticipantLanguage: false,
    },
    bans: [bannedId],
    joinCode: "123456",
    locked: true,
    sizeBytes: 256,
    preview: "행복な preview",
    previewAt: new Date(at.getTime() + 3000),
  };
}

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
      await client.query(`CREATE DATABASE "${name}"`);
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
  const share = shareFixture();
  await stores.shares.create(share);
  const data = Uint8Array.from({ length: 256 }, (_, index) => index);
  await stores.updates.append(shareId, [{ seq: 1, data }], new Date("2026-10-21T10:11:12.456Z"));
  await stores.snapshots.put({
    shareId,
    seq: 1,
    at: new Date("2026-10-21T10:11:13.456Z"),
    kind: "compact",
    state: data,
  });
  await stores.snapshots.put({
    shareId,
    seq: 2,
    at: new Date("2026-10-21T10:11:14.456Z"),
    kind: "history",
    state: data,
  });
  const uploadSize = 3 * 1024 * 1024 + 71;
  const upload = await stores.files.putStream({
    name: "copy-fixture.bin",
    contentType: "application/octet-stream",
    ownerId,
    shareId,
    expiresAt: new Date("2027-01-02T03:04:05.678Z"),
    stream: (async function* () {
      for (let offset = 0; offset < uploadSize; offset += 333 * 1024) {
        const length = Math.min(333 * 1024, uploadSize - offset);
        yield Uint8Array.from({ length }, (_, index) => (offset + index) % 256);
      }
    })(),
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
    expiresAt: new Date("2027-10-18T11:12:13.014Z"),
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
  await stores.audit.append({
    at: new Date("2026-10-23T06:05:04.003Z"),
    actor: ownerId,
    ip: "192.0.2.3",
    action: "share.saved",
    shareId,
    detail: { label: "저장됨", nested: { value: 3 } },
  });
  return { share, data, upload, uploadSize };
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

async function compare(
  source: Awaited<ReturnType<typeof openStores>>["stores"],
  destination: Awaited<ReturnType<typeof openStores>>["stores"],
  fixture: Awaited<ReturnType<typeof seed>>,
) {
  expect(await destination.shares.get(shareId)).toEqual(await source.shares.get(shareId));
  expect(await destination.updates.read(shareId, 0)).toEqual(await source.updates.read(shareId, 0));
  expect(await destination.snapshots.get(shareId, "compact", 1)).toEqual(
    await source.snapshots.get(shareId, "compact", 1),
  );
  expect(await destination.snapshots.get(shareId, "history", 2)).toEqual(
    await source.snapshots.get(shareId, "history", 2),
  );
  expect(await destination.files.meta(fixture.upload.id)).toEqual(
    await source.files.meta(fixture.upload.id),
  );
  expect(await destination.labs.get("LabCopy1")).toEqual(await source.labs.get("LabCopy1"));
  expect(await destination.labels.get(labelClientId, shareId)).toEqual(
    await source.labels.get(labelClientId, shareId),
  );
  expect(await destination.settings.get()).toEqual(await source.settings.get());
  expect(await destination.audit.list({ limit: 10 })).toEqual(
    await source.audit.list({ limit: 10 }),
  );
  const sourceDownload = await source.files.openDownload(fixture.upload.id);
  const destinationDownload = await destination.files.openDownload(fixture.upload.id);
  if (!sourceDownload || !destinationDownload) throw new Error("The upload was not copied");
  expect(sourceDownload.meta).toEqual(destinationDownload.meta);
  const [sourceBytes, destinationBytes] = await Promise.all([
    streamHash(sourceDownload.stream),
    streamHash(destinationDownload.stream),
  ]);
  expect(sourceBytes.size).toBe(fixture.uploadSize);
  expect(destinationBytes).toEqual(sourceBytes);
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
          const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
          const output = execFileSync("pnpm", ["--filter", "@gachipad/api", "copy-db"], {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              GACHIPAD_COPY_FROM: sourceUrl,
              GACHIPAD_COPY_TO: destinationUrl,
            },
          });
          console.log(output.trim());
          expect(output).toContain("Result: success");
          for (const [kind, count] of Object.entries(expectedCopyCounts))
            expect(output).toContain(`${kind}: ${count}`);
        } else {
          const result = await copyDatabase(sourceUrl, destinationUrl);
          expect(result.counts).toEqual(expectedCopyCounts);
        }

        sourceDb = await openStores(sourceUrl);
        destinationDb = await openStores(destinationUrl);
        await compare(sourceDb.stores, destinationDb.stores, fixture);
        await assertUploadCounter(pair.to, destinationUrl, fixture.uploadSize);
      } finally {
        await sourceDb?.close().catch(() => undefined);
        await destinationDb?.close().catch(() => undefined);
        await dropDatabase(pair.from, sourceName, sourceUrl);
        await dropDatabase(pair.to, destinationName, destinationUrl);
      }
    }, 120_000);
  }
});
