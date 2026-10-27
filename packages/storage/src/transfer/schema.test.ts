import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessSchema,
  auditRecordSchema,
  defaultSettings,
  labRecordSchema,
  labStudentSchema,
  type ShareRecord,
  shareLabelRecordSchema,
  shareRecordSchema,
  snapshotRecordSchema,
  updateRecordSchema,
  uploadRecordSchema,
} from "@gachipad/shared";
import { afterEach, describe, expect, it } from "vitest";
import { COLLECTIONS, UPLOADS_BUCKET } from "../mongo.js";
import { openStores } from "../open.js";
import { openSqlDriver } from "../sql/driver.js";
import type { Stores } from "../types.js";
import { copyDatabase } from "./copy.js";
import { mongoDataCollections } from "./mongo.js";
import { transferBackend } from "./registry.js";
import { SQL_DATA_TABLES, SQL_SCHEMA_VERSIONS } from "./sql.js";

/**
 * Guards against schema drift: the copy's own verification reads every side through the same
 * exporters, so a field, column, table or collection they leave out would be left out everywhere
 * and still verify. These tests fail until the transfer code is updated with the schema.
 */

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const shareId = "Full0001";
const future = new Date("2099-01-02T03:04:05.678Z");
const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);

/** One record of every copied kind, with every optional field set. */
async function seedEverything(stores: Stores): Promise<void> {
  const share: ShareRecord = {
    id: shareId,
    title: "Every Field",
    language: "typescript",
    ownerId,
    createdAt: new Date("2026-10-20T08:09:10.123Z"),
    updatedAt: new Date("2026-10-20T08:09:11.123Z"),
    lastActiveAt: new Date("2026-10-20T08:09:12.123Z"),
    expiresAt: future,
    saved: true,
    savedBy: [memberId],
    access: {
      default: "edit",
      editKey: "edit-key",
      generation: "generation-1",
      pinHash: "pin-hash",
      requireApproval: true,
      nearby: true,
      allowParticipantRename: true,
      allowParticipantFiles: true,
      allowParticipantLanguage: true,
    },
    bans: [ownerId],
    joinCode: "123456",
    labId: "FullLab1",
    forkOf: "Fork0001",
    locked: true,
    sizeBytes: 64,
    preview: "preview",
    previewAt: new Date("2026-10-20T08:09:13.123Z"),
  };
  await stores.shares.create(share);
  const at = new Date("2026-10-21T10:11:12.456Z");
  await stores.updates.append(shareId, [{ seq: 1, data: bytes }], at);
  await stores.snapshots.put({ shareId, seq: 1, at, kind: "compact", state: bytes });
  await stores.labs.create({
    id: "FullLab1",
    title: "Lab",
    ownerId,
    joinCode: "654321",
    templateShareId: shareId,
    locked: true,
    students: [{ clientId: memberId, name: "Student", shareId, joinedAt: at }],
    createdAt: at,
    expiresAt: future,
  });
  await stores.labels.set(memberId, shareId, { folder: "Folder", tags: ["tag"] }, at);
  await stores.files.put({
    name: "file.txt",
    contentType: "text/plain",
    ownerId,
    shareId,
    expiresAt: future,
    data: bytes,
  });
  await stores.settings.put({ ...defaultSettings(), contact: "ops@example.invalid" });
  await stores.audit.append({
    at,
    actor: ownerId,
    ip: "192.0.2.1",
    action: "share.saved",
    shareId,
    detail: { kept: true },
  });
}

const fields = (shape: object) => Object.keys(shape).sort();
const expectedFields = {
  shares: fields(shareRecordSchema.shape),
  "shares.access": fields(accessSchema.shape),
  updates: fields(updateRecordSchema.shape),
  snapshots: fields(snapshotRecordSchema.shape),
  uploads: fields(uploadRecordSchema.shape),
  labs: fields(labRecordSchema.shape),
  "labs.students": fields(labStudentSchema.shape),
  labels: fields(shareLabelRecordSchema.shape),
  settings: fields(defaultSettings()),
  audit: fields(auditRecordSchema.shape),
};

/** The field names each kind of exported record carries, merged over all records of the kind. */
async function exportedFields(stores: Stores): Promise<Record<string, string[]>> {
  const found = new Map<string, Set<string>>();
  const add = (kind: string, record: object) => {
    const names = found.get(kind) ?? new Set<string>();
    for (const name of Object.keys(record)) names.add(name);
    found.set(kind, names);
  };
  for await (const item of transferBackend(stores).exportAll(new Date())) {
    if (item.kind === "shareMembers") continue;
    if (item.kind === "uploads") for await (const _chunk of item.chunks);
    add(item.kind, item.record);
    if (item.kind === "shares") add("shares.access", item.record.access);
    if (item.kind === "labs")
      for (const student of item.record.students) add("labs.students", student);
  }
  return Object.fromEntries([...found].map(([kind, names]) => [kind, [...names].sort()]));
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-schema-"));
  tempDirs.push(dir);
  return dir;
}

async function sqlAll(url: string, sql: string) {
  const driver = await openSqlDriver(url);
  try {
    return await driver.all(sql);
  } finally {
    await driver.close();
  }
}

/** Tables and their columns as sql/schema.ts creates them, each with its default as SQL text. */
async function sqliteSchema(
  url: string,
): Promise<Map<string, Array<{ name: string; default: string | null }>>> {
  const schema = new Map<string, Array<{ name: string; default: string | null }>>();
  for (const { name } of await sqlAll(
    url,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ))
    schema.set(
      String(name),
      (await sqlAll(url, `PRAGMA table_info(${String(name)})`)).map((column) => ({
        name: String(column.name),
        default: column.dflt_value == null ? null : String(column.dflt_value),
      })),
    );
  return schema;
}

/** Tables the copy leaves out on purpose. */
const NOT_COPIED = ["diagnostics", "schema_version"];
/**
 * Every column the transfer mappers in sql.ts carry, per copied table, written out independently
 * of sql/schema.ts: a new column fails the test until this list and the mappers are updated. The
 * importer recomputes shares.title_search and upload_capacity.used_bytes.
 */
const TRANSFERRED: Record<string, string[]> = {
  shares: [
    "id",
    "title",
    "title_search",
    "language",
    "owner_id",
    "lab_id",
    "fork_of",
    "created_at",
    "updated_at",
    "last_active_at",
    "expires_at",
    "saved",
    "access_json",
    "join_code",
    "locked",
    "size_bytes",
    "preview",
    "preview_at",
  ],
  share_saved_by: ["share_id", "client_id", "position"],
  share_bans: ["share_id", "client_id", "position"],
  share_updates: ["share_id", "seq", "data", "at"],
  share_snapshots: ["share_id", "kind", "seq", "at", "state"],
  uploads: [
    "id",
    "name",
    "size",
    "content_type",
    "owner_id",
    "share_id",
    "expires_at",
    "created_at",
    "complete",
  ],
  upload_chunks: ["upload_id", "chunk_no", "data"],
  upload_capacity: ["id", "used_bytes"],
  labs: [
    "id",
    "title",
    "owner_id",
    "join_code",
    "template_share_id",
    "locked",
    "students_json",
    "created_at",
    "expires_at",
  ],
  share_labels: ["client_id", "share_id", "folder", "tags_json", "updated_at"],
  settings: ["id", "value_json"],
  audit: ["id", "at", "actor", "ip", "action", "share_id", "detail_json"],
};
/** Columns the copy rewrites on purpose: the write lease of an upload that is already complete. */
const REWRITTEN: Record<string, string[]> = { uploads: ["lease_until"] };

describe("transfer schema coverage", () => {
  it("copies every table and column the SQL schema creates", async () => {
    const dir = await tempDir();
    const source = `sqlite:${join(dir, "source.sqlite")}`;
    const destination = `sqlite:${join(dir, "destination.sqlite")}`;
    const opened = await openStores(source);
    await seedEverything(opened.stores);
    await opened.close();

    const schema = await sqliteSchema(source);
    expect([...schema.keys()]).toEqual(
      [...SQL_DATA_TABLES, "schema_version", "upload_capacity"].sort(),
    );
    expect(
      (await sqlAll(source, "SELECT version FROM schema_version ORDER BY version")).map((row) =>
        Number(row.version),
      ),
    ).toEqual(SQL_SCHEMA_VERSIONS);

    const copied = [...schema.keys()].filter((table) => !NOT_COPIED.includes(table));
    expect(Object.keys(TRANSFERRED).sort(), "copied tables").toEqual(copied);
    for (const table of copied)
      expect(
        (schema.get(table) ?? []).map((column) => column.name).sort(),
        `${table} columns`,
      ).toEqual([...(TRANSFERRED[table] ?? []), ...(REWRITTEN[table] ?? [])].sort());
    // A column the mappers leave out matches when both sides fall back to its default (or null),
    // so the fixture must hold another value in it: extend the fixture first.
    for (const table of copied)
      for (const column of schema.get(table) ?? [])
        expect(
          await sqlAll(
            source,
            `SELECT 1 AS present FROM ${table} WHERE ${column.name} IS NOT ${column.default ?? "NULL"} LIMIT 1`,
          ),
          `${table}.${column.name} holds a value other than its default`,
        ).not.toEqual([]);

    await copyDatabase(source, destination);
    for (const table of copied) {
      const columns = (schema.get(table) ?? [])
        .map((column) => column.name)
        .filter((column) => !REWRITTEN[table]?.includes(column));
      const read = (url: string) =>
        sqlAll(url, `SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns.join(",")}`);
      expect(await read(destination), `${table} rows`).toEqual(await read(source));
    }
  });

  it("exports every field of every record kind", async () => {
    const dir = await tempDir();
    for (const url of ["memory:", `sqlite:${join(dir, "fields.sqlite")}`]) {
      const opened = await openStores(url);
      try {
        await seedEverything(opened.stores);
        expect(await exportedFields(opened.stores), url).toEqual(expectedFields);
      } finally {
        await opened.close();
      }
    }
  });

  it("checks every MongoDB collection the stores write", () => {
    expect(mongoDataCollections().sort()).toEqual(
      [
        ...Object.values(COLLECTIONS),
        "diagnostics",
        `${UPLOADS_BUCKET}.files`,
        `${UPLOADS_BUCKET}.chunks`,
      ].sort(),
    );
  });
});

const mongoBase = process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/gp_copy_base";

describe.skipIf(process.env.GACHIPAD_COPY_INTEGRATION !== "1")(
  "transfer schema coverage on MongoDB",
  () => {
    it("reads every collection and exports every field of a fully populated database", async () => {
      const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/.exec(mongoBase);
      if (!match) throw new Error("Unsupported MongoDB test URL");
      const url = `${match[1]}/gp_copy_schema${match[2] ?? ""}`;
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db();
      try {
        await db.dropDatabase();
        const opened = await openStores(url);
        try {
          await seedEverything(opened.stores);
          const exported = await exportedFields(opened.stores);
          expect(exported).toEqual(expectedFields);

          // Every collection that holds data is one the copy reads or checks.
          const known = [...mongoDataCollections(), "storage_quotas"];
          for (const { name } of await db.listCollections().toArray())
            if (await db.collection(name).findOne({}))
              expect(known, `collection ${name}`).toContain(name);

          // Explicitly mapped documents hold no field the exporter leaves out.
          for (const [collection, kind] of [
            [COLLECTIONS.updates, "updates"],
            [COLLECTIONS.snapshots, "snapshots"],
            [COLLECTIONS.audit, "audit"],
          ] as const)
            for (const document of await db.collection(collection).find({}).toArray())
              for (const name of Object.keys(document))
                if (name !== "_id") expect(exported[kind], `${collection}.${name}`).toContain(name);
          for (const file of await db.collection(`${UPLOADS_BUCKET}.files`).find({}).toArray())
            for (const name of Object.keys(file.metadata ?? {}))
              expect(exported.uploads, `metadata.${name}`).toContain(name);
        } finally {
          await opened.close();
        }
      } finally {
        await db.dropDatabase().catch(() => undefined);
        await client.close();
      }
    }, 60_000);
  },
);
