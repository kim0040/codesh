import type {
  AuditRecord,
  LabRecord,
  ShareRecord,
  SnapshotRecord,
  UploadRecord,
} from "@gachipad/shared";
import { SETTINGS_DOC_ID } from "@gachipad/shared";
import type { SqlDriver, SqlRow } from "../sql/driver.js";
import type { TransferBackend, TransferItem, TransferRecord } from "./types.js";

const PAGE_SIZE = 128;
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
): AsyncIterable<Row[]> {
  let last: Row | undefined;
  for (;;) {
    const rows = await driver.all<Row>(last ? nextSql : firstSql, [
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

export function createSqlTransferBackend(driver: SqlDriver): TransferBackend {
  return {
    async *exportAll(): AsyncIterable<TransferItem> {
      for await (const batch of pages<ShareRow>(
        driver,
        "SELECT * FROM shares ORDER BY id LIMIT ?",
        "SELECT * FROM shares WHERE id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
      )) {
        for (const row of batch) {
          const saved = await driver.all<{ client_id: string }>(
            "SELECT client_id FROM share_saved_by WHERE share_id=? ORDER BY position",
            [row.id],
          );
          const bans = await driver.all<{ client_id: string }>(
            "SELECT client_id FROM share_bans WHERE share_id=? ORDER BY position",
            [row.id],
          );
          yield {
            kind: "shares",
            record: share(
              row,
              saved.map((v) => v.client_id),
              bans.map((v) => v.client_id),
            ),
          };

          let lastSeq: number | undefined;
          for (;;) {
            const updates = await driver.all<UpdateRow>(
              lastSeq === undefined
                ? "SELECT share_id,seq,data,at FROM share_updates WHERE share_id=? ORDER BY seq LIMIT ?"
                : "SELECT share_id,seq,data,at FROM share_updates WHERE share_id=? AND seq>? ORDER BY seq LIMIT ?",
              lastSeq === undefined ? [row.id, PAGE_SIZE] : [row.id, lastSeq, PAGE_SIZE],
            );
            if (!updates.length) break;
            for (const update of updates) yield updateItem(update);
            lastSeq = number(updates.at(-1)?.seq ?? 0);
          }

          let lastKind: string | undefined;
          let lastSnapshotSeq: number | undefined;
          for (;;) {
            const snapshots = await driver.all<SnapshotRow>(
              lastKind === undefined
                ? "SELECT share_id,kind,seq,at,state FROM share_snapshots WHERE share_id=? ORDER BY kind,seq LIMIT ?"
                : "SELECT share_id,kind,seq,at,state FROM share_snapshots WHERE share_id=? AND (kind>? OR (kind=? AND seq>?)) ORDER BY kind,seq LIMIT ?",
              lastKind === undefined
                ? [row.id, PAGE_SIZE]
                : [row.id, lastKind, lastKind, lastSnapshotSeq, PAGE_SIZE],
            );
            if (!snapshots.length) break;
            for (const snapshot of snapshots) yield snapshotItem(snapshot);
            lastKind = snapshots.at(-1)?.kind;
            lastSnapshotSeq = number(snapshots.at(-1)?.seq ?? 0);
          }
        }
      }

      for await (const batch of pages<UpdateRow>(
        driver,
        "SELECT u.share_id,u.seq,u.data,u.at FROM share_updates u WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.id=u.share_id) ORDER BY u.share_id,u.seq LIMIT ?",
        "SELECT u.share_id,u.seq,u.data,u.at FROM share_updates u WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.id=u.share_id) AND (u.share_id>? OR (u.share_id=? AND u.seq>?)) ORDER BY u.share_id,u.seq LIMIT ?",
        (row) => [row.share_id, row.share_id, row.seq],
      )) {
        for (const row of batch) yield updateItem(row);
      }

      for await (const batch of pages<SnapshotRow>(
        driver,
        "SELECT p.share_id,p.kind,p.seq,p.at,p.state FROM share_snapshots p WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.id=p.share_id) ORDER BY p.share_id,p.kind,p.seq LIMIT ?",
        "SELECT p.share_id,p.kind,p.seq,p.at,p.state FROM share_snapshots p WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.id=p.share_id) AND (p.share_id>? OR (p.share_id=? AND p.kind>?) OR (p.share_id=? AND p.kind=? AND p.seq>?)) ORDER BY p.share_id,p.kind,p.seq LIMIT ?",
        (row) => [row.share_id, row.share_id, row.kind, row.share_id, row.kind, row.seq],
      )) {
        for (const row of batch) yield snapshotItem(row);
      }

      for await (const batch of pages<SqlRow & { id: string }>(
        driver,
        "SELECT id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at FROM labs ORDER BY id LIMIT ?",
        "SELECT id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at FROM labs WHERE id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
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
        "SELECT client_id,share_id,folder,tags_json,updated_at FROM share_labels ORDER BY client_id,share_id LIMIT ?",
        "SELECT client_id,share_id,folder,tags_json,updated_at FROM share_labels WHERE client_id>? OR (client_id=? AND share_id>?) ORDER BY client_id,share_id LIMIT ?",
        (row) => [row.client_id, row.client_id, row.share_id],
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

      for await (const batch of pages<SqlRow & { id: string }>(
        driver,
        "SELECT id,name,size,content_type,owner_id,share_id,expires_at,created_at FROM uploads WHERE complete=TRUE ORDER BY id LIMIT ?",
        "SELECT id,name,size,content_type,owner_id,share_id,expires_at,created_at FROM uploads WHERE complete=TRUE AND id>? ORDER BY id LIMIT ?",
        (row) => [row.id],
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
        const exists =
          driver.dialect === "sqlite"
            ? await driver.all(
                "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                [table],
              )
            : driver.dialect === "postgres"
              ? await driver.all(
                  "SELECT 1 AS present FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=? LIMIT 1",
                  [table],
                )
              : await driver.all(
                  "SELECT 1 AS present FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1",
                  [table],
                );
        if (!exists.length) continue;
        if ((await driver.all(`SELECT 1 AS present FROM ${table} LIMIT 1`)).length) return false;
      }
      const capacityExists =
        driver.dialect === "sqlite"
          ? await driver.all(
              "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='upload_capacity' LIMIT 1",
            )
          : driver.dialect === "postgres"
            ? await driver.all(
                "SELECT 1 AS present FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='upload_capacity' LIMIT 1",
              )
            : await driver.all(
                "SELECT 1 AS present FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='upload_capacity' LIMIT 1",
              );
      if (!capacityExists.length) return true;
      const capacity = await driver.all<{ used_bytes: number | string }>(
        "SELECT used_bytes FROM upload_capacity WHERE id=1",
      );
      return number(capacity[0]?.used_bytes ?? 0) === 0;
    },

    async recomputeCounters() {
      await driver.run(
        "UPDATE upload_capacity SET used_bytes=(SELECT COALESCE(SUM(size),0) FROM uploads WHERE complete=TRUE) WHERE id=1",
      );
    },
  };
}
