import type {
  AuditRecord,
  LabRecord,
  ShareRecord,
  SnapshotRecord,
  UploadRecord,
} from "@gachipad/shared";
import { SETTINGS_DOC_ID } from "@gachipad/shared";
import type { SqlDriver, SqlRow } from "../sql/driver.js";
import { MEMBER_PAGE } from "./members.js";
import type { ShareMembers, TransferBackend, TransferItem, TransferRecord } from "./types.js";

const PAGE_SIZE = 128;
/** Update and snapshot bodies read at once; a single larger body is read on its own. */
const PAGE_BYTES = 2 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 256 * 1024;
const UPLOAD_BATCH_CHUNKS = 8;
const blob = (value: Uint8Array) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const number = (value: number | string) => Number(value);

type ShareRow = SqlRow & {
  id: string;
  title: string;
  language: string;
  owner_id: string;
  lab_id: string | null;
  fork_of: string | null;
  created_at: number | string;
  updated_at: number | string;
  last_active_at: number | string;
  expires_at: number | string | null;
  saved: boolean | number;
  access_json: string;
  join_code: string;
  locked: boolean | number;
  size_bytes: number | string;
  preview: string | null;
  preview_at: number | string | null;
};

function share(row: ShareRow, savedBy: string[], bans: string[]): ShareRecord {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    ownerId: row.owner_id,
    ...(row.lab_id == null ? {} : { labId: row.lab_id }),
    ...(row.fork_of == null ? {} : { forkOf: row.fork_of }),
    createdAt: new Date(number(row.created_at)),
    updatedAt: new Date(number(row.updated_at)),
    lastActiveAt: new Date(number(row.last_active_at)),
    expiresAt: row.expires_at == null ? null : new Date(number(row.expires_at)),
    saved: row.saved === true || number(row.saved as number | string) === 1,
    savedBy,
    access: JSON.parse(row.access_json),
    bans,
    joinCode: row.join_code,
    locked: row.locked === true || number(row.locked as number | string) === 1,
    sizeBytes: number(row.size_bytes),
    ...(row.preview == null ? {} : { preview: row.preview }),
    ...(row.preview_at == null ? {} : { previewAt: new Date(number(row.preview_at)) }),
  };
}

async function* pages<Row extends SqlRow>(
  driver: SqlDriver,
  firstSql: string,
  nextSql: string,
  nextValues: (last: Row) => unknown[],
  values: unknown[] = [],
): AsyncIterable<Row[]> {
  let last: Row | undefined;
  for (;;) {
    const rows = await driver.all<Row>(last ? nextSql : firstSql, [
      ...values,
      ...(last ? nextValues(last) : []),
      PAGE_SIZE,
    ]);
    if (!rows.length) return;
    yield rows;
    last = rows.at(-1);
  }
}

async function* uploadChunks(driver: SqlDriver, id: string, size: number) {
  let expected = 0;
  let total = 0;
  for (;;) {
    const rows = await driver.all<{ chunk_no: number | string; data: Uint8Array }>(
      "SELECT chunk_no,data FROM upload_chunks WHERE upload_id=? AND chunk_no>=? ORDER BY chunk_no LIMIT 8",
      [id, expected],
    );
    if (!rows.length) break;
    for (const row of rows) {
      if (number(row.chunk_no) !== expected++)
        throw new Error("Stored upload chunks are incomplete");
      total += row.data.byteLength;
      if (total > size) throw new Error("Stored upload chunks exceed metadata size");
      yield Uint8Array.from(row.data);
    }
  }
  if (total !== size) throw new Error("Stored upload chunks do not match metadata size");
}

type UpdateRow = SqlRow & {
  share_id: string;
  seq: number | string;
  data: Uint8Array;
  at: number | string;
};
type SnapshotRow = SqlRow & {
  share_id: string;
  kind: string;
  seq: number | string;
  at: number | string;
  state: Uint8Array;
};

function updateItem(row: UpdateRow): TransferItem {
  return {
    kind: "updates",
    record: {
      shareId: row.share_id,
      seq: number(row.seq),
      data: Uint8Array.from(row.data),
      at: new Date(number(row.at)),
    },
  };
}

function snapshotItem(row: SnapshotRow): TransferItem {
  return {
    kind: "snapshots",
    record: {
      shareId: row.share_id,
      kind: row.kind as SnapshotRecord["kind"],
      seq: number(row.seq),
      at: new Date(number(row.at)),
      state: Uint8Array.from(row.state),
    },
  };
}

type MemberRow = SqlRow & { position: number | string; client_id: string };
const MEMBER_TABLES = { savedBy: "share_saved_by", bans: "share_bans" } as const;

function memberPage(
  driver: SqlDriver,
  list: ShareMembers["list"],
  shareId: string,
  after?: MemberRow,
): Promise<MemberRow[]> {
  const table = MEMBER_TABLES[list];
  return after
    ? driver.all<MemberRow>(
        `SELECT position,client_id FROM ${table} WHERE share_id=? AND (position>? OR (position=? AND client_id>?)) ORDER BY position,client_id LIMIT ?`,
        [shareId, after.position, after.position, after.client_id, MEMBER_PAGE],
      )
    : driver.all<MemberRow>(
        `SELECT position,client_id FROM ${table} WHERE share_id=? ORDER BY position,client_id LIMIT ?`,
        [shareId, MEMBER_PAGE],
      );
}

/** The rest of a member list after its first page, which travels in the share record. */
async function* moreMembers(
  driver: SqlDriver,
  list: ShareMembers["list"],
  shareId: string,
  first: MemberRow[],
): AsyncIterable<TransferItem> {
  let page = first;
  let offset = page.length;
  while (page.length === MEMBER_PAGE) {
    page = await memberPage(driver, list, shareId, page.at(-1));
    if (!page.length) return;
    yield {
      kind: "shareMembers",
      record: { shareId, list, offset, clientIds: page.map((row) => row.client_id) },
    };
    offset += page.length;
  }
}

type SizedKey = SqlRow & { bytes: number | string };

/** Splits keys into runs whose bodies fit PAGE_BYTES; a larger body forms a run of its own. */
function byteRuns<Key extends SizedKey>(keys: Key[]): Array<[Key, ...Key[]]> {
  const runs: Array<[Key, ...Key[]]> = [];
  let run: Key[] = [];
  let size = 0;
  for (const key of keys) {
    const bytes = number(key.bytes);
    if (run[0] && size + bytes > PAGE_BYTES) {
      runs.push(run as [Key, ...Key[]]);
      run = [];
      size = 0;
    }
    run.push(key);
    size += bytes;
  }
  if (run[0]) runs.push(run as [Key, ...Key[]]);
  return runs;
}

/** Reads key and body size first, then bodies in byte-bounded runs. */
async function* shareUpdates(driver: SqlDriver, shareId: string): AsyncIterable<TransferItem> {
  type Key = SizedKey & { seq: number | string };
  let after: number | undefined;
  for (;;) {
    const keys = await driver.all<Key>(
      after === undefined
        ? "SELECT seq,LENGTH(data) AS bytes FROM share_updates WHERE share_id=? ORDER BY seq LIMIT ?"
        : "SELECT seq,LENGTH(data) AS bytes FROM share_updates WHERE share_id=? AND seq>? ORDER BY seq LIMIT ?",
      after === undefined ? [shareId, PAGE_SIZE] : [shareId, after, PAGE_SIZE],
    );
    for (const run of byteRuns(keys)) {
      const rows = await driver.all<UpdateRow>(
        "SELECT share_id,seq,data,at FROM share_updates WHERE share_id=? AND seq>=? AND seq<=? ORDER BY seq LIMIT ?",
        [shareId, number(run[0].seq), number(run[run.length - 1]?.seq ?? run[0].seq), run.length],
      );
      for (const row of rows) yield updateItem(row);
    }
    const last = keys.at(-1);
    if (!last) return;
    after = number(last.seq);
  }
}

async function* shareSnapshots(driver: SqlDriver, shareId: string): AsyncIterable<TransferItem> {
  type Key = SizedKey & { kind: string; seq: number | string };
  let after: Key | undefined;
  for (;;) {
    const keys = await driver.all<Key>(
      after === undefined
        ? "SELECT kind,seq,LENGTH(state) AS bytes FROM share_snapshots WHERE share_id=? ORDER BY kind,seq LIMIT ?"
        : "SELECT kind,seq,LENGTH(state) AS bytes FROM share_snapshots WHERE share_id=? AND (kind>? OR (kind=? AND seq>?)) ORDER BY kind,seq LIMIT ?",
      after === undefined
        ? [shareId, PAGE_SIZE]
        : [shareId, after.kind, after.kind, number(after.seq), PAGE_SIZE],
    );
    for (const run of byteRuns(keys)) {
      const first = run[0];
      const last = run[run.length - 1] ?? first;
      const rows = await driver.all<SnapshotRow>(
        "SELECT share_id,kind,seq,at,state FROM share_snapshots WHERE share_id=? AND (kind>? OR (kind=? AND seq>=?)) AND (kind<? OR (kind=? AND seq<=?)) ORDER BY kind,seq LIMIT ?",
        [
          shareId,
          first.kind,
          first.kind,
          number(first.seq),
          last.kind,
          last.kind,
          number(last.seq),
          run.length,
        ],
      );
      for (const row of rows) yield snapshotItem(row);
    }
    after = keys.at(-1);
    if (!after) return;
  }
}

/** Unqualified table names resolve like the importer's statements: search_path on PostgreSQL. */
async function tableExists(driver: SqlDriver, table: string): Promise<boolean> {
  const rows =
    driver.dialect === "sqlite"
      ? await driver.all(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
          [table],
        )
      : driver.dialect === "postgres"
        ? await driver.all("SELECT 1 AS present WHERE to_regclass(?) IS NOT NULL", [table])
        : await driver.all(
            "SELECT 1 AS present FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1",
            [table],
          );
  return rows.length > 0;
}

export function createSqlTransferBackend(driver: SqlDriver): TransferBackend {
  return {
    async *exportAll(liveAt: Date): AsyncIterable<TransferItem> {
      const live = liveAt.getTime();
      for await (const batch of pages<ShareRow>(
        driver,
        "SELECT * FROM shares WHERE (expires_at IS NULL OR expires_at>=?) ORDER BY id LIMIT ?",
        "SELECT * FROM shares WHERE (expires_at IS NULL OR expires_at>=?) AND id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
        [live],
      )) {
        for (const row of batch) {
          const saved = await memberPage(driver, "savedBy", row.id);
          const bans = await memberPage(driver, "bans", row.id);
          yield {
            kind: "shares",
            record: share(
              row,
              saved.map((v) => v.client_id),
              bans.map((v) => v.client_id),
            ),
          };
          yield* moreMembers(driver, "savedBy", row.id, saved);
          yield* moreMembers(driver, "bans", row.id, bans);
          yield* shareUpdates(driver, row.id);
          yield* shareSnapshots(driver, row.id);
        }
      }

      for await (const batch of pages<SqlRow & { id: string }>(
        driver,
        "SELECT id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at FROM labs WHERE expires_at>=? ORDER BY id LIMIT ?",
        "SELECT id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at FROM labs WHERE expires_at>=? AND id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
        [live],
      )) {
        for (const row of batch) {
          const students = (
            JSON.parse(row.students_json as string) as Array<
              Omit<LabRecord["students"][number], "joinedAt"> & { joinedAt: string }
            >
          ).map((student) => ({ ...student, joinedAt: new Date(student.joinedAt) }));
          yield {
            kind: "labs",
            record: {
              id: row.id,
              title: row.title as string,
              ownerId: row.owner_id as string,
              joinCode: row.join_code as string,
              templateShareId: row.template_share_id as string | null,
              locked: row.locked === true || number(row.locked as number | string) === 1,
              students,
              createdAt: new Date(number(row.created_at as number | string)),
              expiresAt: new Date(number(row.expires_at as number | string)),
            },
          };
        }
      }

      for await (const batch of pages<SqlRow & { client_id: string; share_id: string }>(
        driver,
        "SELECT l.client_id,l.share_id,l.folder,l.tags_json,l.updated_at FROM share_labels l JOIN shares s ON s.id=l.share_id WHERE (s.expires_at IS NULL OR s.expires_at>=?) ORDER BY l.client_id,l.share_id LIMIT ?",
        "SELECT l.client_id,l.share_id,l.folder,l.tags_json,l.updated_at FROM share_labels l JOIN shares s ON s.id=l.share_id WHERE (s.expires_at IS NULL OR s.expires_at>=?) AND (l.client_id>? OR (l.client_id=? AND l.share_id>?)) ORDER BY l.client_id,l.share_id LIMIT ?",
        (row) => [row.client_id, row.client_id, row.share_id],
        [live],
      )) {
        for (const row of batch)
          yield {
            kind: "labels",
            record: {
              clientId: row.client_id,
              shareId: row.share_id,
              folder: row.folder as string | null,
              tags: JSON.parse(row.tags_json as string),
              updatedAt: new Date(number(row.updated_at as number | string)),
            },
          };
      }

      const settings = await driver.all<{ value_json: string }>(
        "SELECT value_json FROM settings WHERE id=?",
        [SETTINGS_DOC_ID],
      );
      if (settings[0]) yield { kind: "settings", record: JSON.parse(settings[0].value_json) };

      for await (const batch of pages<SqlRow & { id: string }>(
        driver,
        "SELECT id,at,actor,ip,action,share_id,detail_json FROM audit ORDER BY id LIMIT ?",
        "SELECT id,at,actor,ip,action,share_id,detail_json FROM audit WHERE id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
      )) {
        for (const row of batch) {
          const record: AuditRecord = {
            at: new Date(number(row.at as number | string)),
            actor: row.actor as string,
            ip: row.ip as string,
            action: row.action as string,
            ...(row.share_id == null ? {} : { shareId: row.share_id as string }),
            ...(row.detail_json == null ? {} : { detail: JSON.parse(row.detail_json as string) }),
          };
          yield { kind: "audit", id: row.id, record };
        }
      }

      const liveUploads =
        "FROM uploads u LEFT JOIN shares s ON s.id=u.share_id WHERE u.complete=TRUE AND u.expires_at>=? AND (u.share_id IS NULL OR (s.id IS NOT NULL AND (s.expires_at IS NULL OR s.expires_at>=?)))";
      for await (const batch of pages<SqlRow & { id: string }>(
        driver,
        `SELECT u.id,u.name,u.size,u.content_type,u.owner_id,u.share_id,u.expires_at,u.created_at ${liveUploads} ORDER BY u.id LIMIT ?`,
        `SELECT u.id,u.name,u.size,u.content_type,u.owner_id,u.share_id,u.expires_at,u.created_at ${liveUploads} AND u.id>? ORDER BY u.id LIMIT ?`,
        (row) => [row.id],
        [live, live],
      )) {
        for (const row of batch) {
          const size = number(row.size as number | string);
          const record: UploadRecord = {
            id: row.id,
            name: row.name as string,
            size,
            contentType: row.content_type as string | null,
            ownerId: row.owner_id as string,
            ...(row.share_id == null ? {} : { shareId: row.share_id as string }),
            expiresAt: new Date(number(row.expires_at as number | string)),
          };
          yield {
            kind: "uploads",
            record,
            createdAt: new Date(number(row.created_at as number | string)),
            chunks: uploadChunks(driver, row.id, size),
          };
        }
      }
    },

    async countLive(liveAt: Date) {
      const live = liveAt.getTime();
      const [shares] = await driver.all<{ total: number | string }>(
        "SELECT COUNT(*) AS total FROM shares WHERE expires_at IS NULL OR expires_at>=?",
        [live],
      );
      const [labs] = await driver.all<{ total: number | string }>(
        "SELECT COUNT(*) AS total FROM labs WHERE expires_at>=?",
        [live],
      );
      return { shares: number(shares?.total ?? 0), labs: number(labs?.total ?? 0) };
    },

    async importBatch(items: readonly TransferRecord[]) {
      if (!items.length) return;
      await driver.transaction(async (tx) => {
        for (const item of items) {
          switch (item.kind) {
            case "shares": {
              const value = item.record;
              await tx.run(
                "INSERT INTO shares (id,title,title_search,language,owner_id,lab_id,fork_of,created_at,updated_at,last_active_at,expires_at,saved,access_json,join_code,locked,size_bytes,preview,preview_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                  value.id,
                  value.title,
                  value.title.toLowerCase(),
                  value.language,
                  value.ownerId,
                  value.labId ?? null,
                  value.forkOf ?? null,
                  value.createdAt.getTime(),
                  value.updatedAt.getTime(),
                  value.lastActiveAt.getTime(),
                  value.expiresAt?.getTime() ?? null,
                  value.saved,
                  JSON.stringify(value.access),
                  value.joinCode,
                  value.locked,
                  value.sizeBytes,
                  value.preview ?? null,
                  value.previewAt?.getTime() ?? null,
                ],
              );
              for (const [position, clientId] of value.savedBy.entries())
                await tx.run(
                  "INSERT INTO share_saved_by (share_id,client_id,position) VALUES (?,?,?)",
                  [value.id, clientId, position],
                );
              for (const [position, clientId] of value.bans.entries())
                await tx.run(
                  "INSERT INTO share_bans (share_id,client_id,position) VALUES (?,?,?)",
                  [value.id, clientId, position],
                );
              break;
            }
            case "shareMembers": {
              const { shareId, list, offset, clientIds } = item.record;
              for (const [index, clientId] of clientIds.entries())
                await tx.run(
                  `INSERT INTO ${MEMBER_TABLES[list]} (share_id,client_id,position) VALUES (?,?,?)`,
                  [shareId, clientId, offset + index],
                );
              break;
            }
            case "updates":
              await tx.run("INSERT INTO share_updates (share_id,seq,data,at) VALUES (?,?,?,?)", [
                item.record.shareId,
                item.record.seq,
                blob(item.record.data),
                item.record.at.getTime(),
              ]);
              break;
            case "snapshots":
              await tx.run(
                "INSERT INTO share_snapshots (share_id,kind,seq,at,state) VALUES (?,?,?,?,?)",
                [
                  item.record.shareId,
                  item.record.kind,
                  item.record.seq,
                  item.record.at.getTime(),
                  blob(item.record.state),
                ],
              );
              break;
            case "labs": {
              const value = item.record;
              await tx.run(
                "INSERT INTO labs (id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
                [
                  value.id,
                  value.title,
                  value.ownerId,
                  value.joinCode,
                  value.templateShareId,
                  value.locked,
                  JSON.stringify(value.students),
                  value.createdAt.getTime(),
                  value.expiresAt.getTime(),
                ],
              );
              break;
            }
            case "labels":
              await tx.run(
                "INSERT INTO share_labels (client_id,share_id,folder,tags_json,updated_at) VALUES (?,?,?,?,?)",
                [
                  item.record.clientId,
                  item.record.shareId,
                  item.record.folder,
                  JSON.stringify(item.record.tags),
                  item.record.updatedAt.getTime(),
                ],
              );
              break;
            case "settings": {
              const sql =
                driver.dialect === "mysql"
                  ? "INSERT INTO settings (id,value_json) VALUES (?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)"
                  : "INSERT INTO settings (id,value_json) VALUES (?,?) ON CONFLICT (id) DO UPDATE SET value_json=excluded.value_json";
              await tx.run(sql, [SETTINGS_DOC_ID, JSON.stringify(item.record)]);
              break;
            }
            case "audit":
              await tx.run(
                "INSERT INTO audit (id,at,actor,ip,action,share_id,detail_json) VALUES (?,?,?,?,?,?,?)",
                [
                  item.id,
                  item.record.at.getTime(),
                  item.record.actor,
                  item.record.ip,
                  item.record.action,
                  item.record.shareId ?? null,
                  item.record.detail === undefined ? null : JSON.stringify(item.record.detail),
                ],
              );
              break;
          }
        }
      });
    },

    async importUpload(record, createdAt, chunks) {
      await driver.run(
        "INSERT INTO uploads (id,name,size,content_type,owner_id,share_id,expires_at,created_at,complete,lease_until) VALUES (?,?,?,?,?,?,?,?,FALSE,0)",
        [
          record.id,
          record.name,
          record.size,
          record.contentType,
          record.ownerId,
          record.shareId ?? null,
          record.expiresAt.getTime(),
          createdAt.getTime(),
        ],
      );
      let size = 0;
      let chunkNo = 0;
      let filled = 0;
      const pending = Buffer.allocUnsafe(UPLOAD_CHUNK_BYTES);
      let batch: Array<{ no: number; data: Uint8Array }> = [];
      const flush = async () => {
        if (!batch.length) return;
        const entries = batch;
        await driver.transaction(async (tx) => {
          for (const entry of entries)
            await tx.run("INSERT INTO upload_chunks (upload_id,chunk_no,data) VALUES (?,?,?)", [
              record.id,
              entry.no,
              blob(entry.data),
            ]);
        });
        batch = [];
      };
      const saveChunk = async (data: Uint8Array) => {
        batch.push({ no: chunkNo++, data });
        if (batch.length >= UPLOAD_BATCH_CHUNKS) await flush();
      };

      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > record.size) throw new Error("Upload content exceeded its stored size");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const length = Math.min(UPLOAD_CHUNK_BYTES - filled, chunk.byteLength - offset);
          pending.set(chunk.subarray(offset, offset + length), filled);
          filled += length;
          offset += length;
          if (filled === UPLOAD_CHUNK_BYTES) {
            await saveChunk(pending.slice());
            filled = 0;
          }
        }
      }
      if (size !== record.size) throw new Error("Upload content did not match its stored size");
      if (filled) await saveChunk(pending.slice(0, filled));
      await driver.transaction(async (tx) => {
        for (const entry of batch)
          await tx.run("INSERT INTO upload_chunks (upload_id,chunk_no,data) VALUES (?,?,?)", [
            record.id,
            entry.no,
            blob(entry.data),
          ]);
        await tx.run("UPDATE uploads SET complete=TRUE WHERE id=?", [record.id]);
        await tx.run("UPDATE upload_capacity SET used_bytes=used_bytes+? WHERE id=1", [size]);
      });
    },

    async isEmpty() {
      const tables = [
        "shares",
        "share_saved_by",
        "share_bans",
        "share_updates",
        "share_snapshots",
        "uploads",
        "upload_chunks",
        "labs",
        "share_labels",
        "settings",
        "audit",
        "diagnostics",
      ];
      for (const table of tables) {
        if (!(await tableExists(driver, table))) continue;
        if ((await driver.all(`SELECT 1 AS present FROM ${table} LIMIT 1`)).length) return false;
      }
      // Only a zero singleton counter belongs to an empty database; a missing one is recreated.
      if (!(await tableExists(driver, "upload_capacity"))) return true;
      return !(
        await driver.all(
          "SELECT 1 AS present FROM upload_capacity WHERE id<>1 OR used_bytes<>0 LIMIT 1",
        )
      ).length;
    },

    async recomputeCounters() {
      const [usage] = await driver.all<{ total: number | string | null }>(
        "SELECT COALESCE(SUM(size),0) AS total FROM uploads WHERE complete=TRUE",
      );
      await driver.run(
        driver.dialect === "mysql"
          ? "INSERT INTO upload_capacity (id,used_bytes) VALUES (1,?) ON DUPLICATE KEY UPDATE used_bytes=VALUES(used_bytes)"
          : "INSERT INTO upload_capacity (id,used_bytes) VALUES (1,?) ON CONFLICT (id) DO UPDATE SET used_bytes=excluded.used_bytes",
        [number(usage?.total ?? 0)],
      );
    },

    async uploadCounter() {
      const rows = await driver.all<{ id: number | string; used_bytes: number | string }>(
        "SELECT id,used_bytes FROM upload_capacity ORDER BY id LIMIT 2",
      );
      const [row] = rows;
      return rows.length === 1 && row && number(row.id) === 1 ? number(row.used_bytes) : Number.NaN;
    },
  };
}
