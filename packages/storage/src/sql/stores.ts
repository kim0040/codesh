import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  type AuditRecord,
  type DiagnosticSnapshot,
  defaultSettings,
  type LabRecord,
  type LabStudent,
  SETTINGS_DOC_ID,
  type Settings,
  type ShareLabelRecord,
  type ShareLabels,
  type ShareRecord,
  type SnapshotKind,
  type SnapshotRecord,
  scrubDiagnosticSnapshot,
  settingsSchema,
  type UploadRecord,
} from "@gachipad/shared";
import {
  type AuditQuery,
  DuplicateSeqError,
  type FileStore,
  FileTooLargeError,
  type LabelStore,
  type LabStore,
  type LabUpdate,
  type NewUpload,
  type NewUploadStream,
  type SettingsStore,
  type ShareStore,
  type ShareUpdate,
  type SnapshotStore,
  StorageCapacityError,
  type Stores,
  type UpdateEntry,
  type UpdateLog,
} from "../types.js";
import type { SqlDriver, SqlExecutor, SqlRow } from "./driver.js";
import { ignoreInsertSql, supportsForUpdate } from "./driver.js";

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

type LabRow = SqlRow & {
  id: string;
  title: string;
  owner_id: string;
  join_code: string;
  template_share_id: string | null;
  locked: boolean | number;
  students_json: string;
  created_at: number | string;
  expires_at: number | string;
};

const dateNum = (date: Date | null | undefined) => (date == null ? null : date.getTime());
const dateVal = (value: unknown): Date | null => (value == null ? null : new Date(Number(value)));
const bool = (value: unknown) => value === true || Number(value) === 1;
const json = <T>(value: string): T => JSON.parse(value) as T;
const bytes = (value: unknown): Uint8Array<ArrayBuffer> => Uint8Array.from(value as Uint8Array);
const blob = (value: Uint8Array) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
const visibleShare = "(expires_at IS NULL OR expires_at > ?)";

function isDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return (
    code === "23505" ||
    code === "ER_DUP_ENTRY" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    /UNIQUE constraint failed: share_updates/i.test(message)
  );
}

async function savedIds(tx: SqlExecutor, table: "share_saved_by" | "share_bans", shareId: string) {
  const rows = await tx.all<{ client_id: string }>(
    `SELECT client_id FROM ${table} WHERE share_id = ? ORDER BY position`,
    [shareId],
  );
  return rows.map((row) => row.client_id);
}

async function nextPosition(
  tx: SqlExecutor,
  table: "share_saved_by" | "share_bans",
  shareId: string,
) {
  const rows = await tx.all<{ position: number | string | null }>(
    `SELECT MAX(position) AS position FROM ${table} WHERE share_id=?`,
    [shareId],
  );
  return Number(rows[0]?.position ?? -1) + 1;
}

async function readShare(
  tx: SqlExecutor,
  id: string,
  lock = false,
  dialect: SqlDriver["dialect"] = "sqlite",
  visible = false,
): Promise<ShareRecord | null> {
  const suffix = lock && supportsForUpdate(dialect) ? " FOR UPDATE" : "";
  const rows = await tx.all<ShareRow>(
    `SELECT * FROM shares WHERE id = ?${visible ? ` AND ${visibleShare}` : ""}${suffix}`,
    visible ? [id, Date.now()] : [id],
  );
  const row = rows[0];
  if (!row) return null;
  return (await hydrateShares(tx, [row]))[0] ?? null;
}

async function hydrateShares(tx: SqlExecutor, rows: ShareRow[]): Promise<ShareRecord[]> {
  const saved = new Map<string, string[]>();
  const banned = new Map<string, string[]>();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((row) => row.id);
    const marks = ids.map(() => "?").join(",");
    for (const [table, target] of [
      ["share_saved_by", saved],
      ["share_bans", banned],
    ] as const) {
      const entries = await tx.all<{ share_id: string; client_id: string }>(
        `SELECT share_id,client_id FROM ${table} WHERE share_id IN (${marks}) ORDER BY position`,
        ids,
      );
      for (const entry of entries) {
        const values = target.get(entry.share_id) ?? [];
        values.push(entry.client_id);
        target.set(entry.share_id, values);
      }
    }
  }
  return rows.map((row) => shareRecord(row, saved.get(row.id) ?? [], banned.get(row.id) ?? []));
}

function shareRecord(row: ShareRow, savedBy: string[], bans: string[]): ShareRecord {
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    ownerId: row.owner_id,
    ...(row.lab_id == null ? {} : { labId: row.lab_id }),
    ...(row.fork_of == null ? {} : { forkOf: row.fork_of }),
    createdAt: new Date(Number(row.created_at)),
    updatedAt: new Date(Number(row.updated_at)),
    lastActiveAt: new Date(Number(row.last_active_at)),
    expiresAt: dateVal(row.expires_at),
    saved: bool(row.saved),
    savedBy,
    access: json(row.access_json),
    bans,
    joinCode: row.join_code,
    locked: bool(row.locked),
    sizeBytes: Number(row.size_bytes),
    ...(row.preview == null ? {} : { preview: row.preview }),
    ...(row.preview_at == null ? {} : { previewAt: new Date(Number(row.preview_at)) }),
  } as ShareRecord;
}

async function readLab(
  tx: SqlExecutor,
  id: string,
  lock = false,
  dialect: SqlDriver["dialect"] = "sqlite",
): Promise<LabRecord | null> {
  const suffix = lock && supportsForUpdate(dialect) ? " FOR UPDATE" : "";
  const rows = await tx.all<LabRow>(`SELECT * FROM labs WHERE id = ?${suffix}`, [id]);
  const row = rows[0];
  if (!row) return null;
  const students = json<Array<Omit<LabStudent, "joinedAt"> & { joinedAt: string }>>(
    row.students_json,
  ).map((student) => ({ ...student, joinedAt: new Date(student.joinedAt) }));
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    joinCode: row.join_code,
    templateShareId: row.template_share_id,
    locked: bool(row.locked),
    students,
    createdAt: new Date(Number(row.created_at)),
    expiresAt: new Date(Number(row.expires_at)),
  };
}

async function deleteShareChildren(
  tx: SqlExecutor,
  shareId: string,
  dialect: SqlDriver["dialect"],
): Promise<void> {
  await tx.run("DELETE FROM share_updates WHERE share_id = ?", [shareId]);
  await tx.run("DELETE FROM share_snapshots WHERE share_id = ?", [shareId]);
  await deleteUploads(tx, dialect, "share_id=?", [shareId]);
  await tx.run("DELETE FROM share_labels WHERE share_id = ?", [shareId]);
}

async function deleteUploads(
  tx: SqlExecutor,
  dialect: SqlDriver["dialect"],
  where: string,
  values: unknown[],
) {
  const suffix = supportsForUpdate(dialect) ? " FOR UPDATE" : "";
  if (suffix) await tx.all("SELECT used_bytes FROM upload_capacity WHERE id=1 FOR UPDATE");
  // Locking reads see committed rows even under MySQL REPEATABLE READ.
  const rows = await tx.all<{ id: string; size: number | string }>(
    `SELECT id,size FROM uploads WHERE ${where} ORDER BY id${suffix}`,
    values,
  );
  let removed = 0;
  let released = 0;
  for (const row of rows) {
    const count = await tx.run("DELETE FROM uploads WHERE id=?", [row.id]);
    removed += count;
    if (count) released += Number(row.size);
  }
  if (released)
    await tx.run("UPDATE upload_capacity SET used_bytes=used_bytes-? WHERE id=1", [released]);
  return removed;
}

class SqlShareStore implements ShareStore {
  constructor(private readonly driver: SqlDriver) {}

  async adminList(search: string, before?: Date, beforeId?: string) {
    const conditions = [visibleShare];
    const values: unknown[] = [Date.now()];
    if (search) {
      const escaped = search.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`);
      conditions.push("title_search LIKE ? ESCAPE '!'");
      values.push(`%${escaped}%`);
    }
    if (before) {
      conditions.push(
        beforeId ? "(created_at < ? OR (created_at = ? AND id < ?))" : "created_at < ?",
      );
      values.push(before.getTime());
      if (beforeId) values.push(before.getTime(), beforeId);
    }
    const rows = await this.driver.all<ShareRow>(
      `SELECT id, title, language, saved, owner_id, lab_id, created_at, last_active_at, expires_at, size_bytes, locked
       FROM shares WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 100`,
      values,
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      language: row.language,
      saved: bool(row.saved),
      ownerId: row.owner_id,
      ...(row.lab_id ? { labId: row.lab_id } : {}),
      createdAt: new Date(Number(row.created_at)),
      lastActiveAt: new Date(Number(row.last_active_at)),
      expiresAt: dateVal(row.expires_at),
      sizeBytes: Number(row.size_bytes),
      locked: bool(row.locked),
    }));
  }

  async adminSummary() {
    const now = Date.now();
    const counts = Array.from(
      { length: 24 },
      (_, i) => `SUM(CASE WHEN created_at>? AND created_at<=? THEN 1 ELSE 0 END) AS h${i}`,
    );
    const values: unknown[] = [];
    for (let i = 0; i < 24; i++)
      values.push(now - (24 - i) * 3_600_000, now - (23 - i) * 3_600_000);
    values.push(now);
    const [row] = await this.driver.all(
      `SELECT COUNT(*) AS total,${counts.join(",")} FROM shares WHERE ${visibleShare}`,
      values,
    );
    return {
      shares: Number(row?.total ?? 0),
      activity: Array.from({ length: 24 }, (_, i) => Number(row?.[`h${i}`] ?? 0)),
    };
  }

  async create(share: ShareRecord) {
    await this.driver.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO shares (id,title,title_search,language,owner_id,lab_id,fork_of,created_at,updated_at,last_active_at,expires_at,saved,access_json,join_code,locked,size_bytes,preview,preview_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          share.id,
          share.title,
          share.title.toLowerCase(),
          share.language,
          share.ownerId,
          share.labId ?? null,
          share.forkOf ?? null,
          share.createdAt.getTime(),
          share.updatedAt.getTime(),
          share.lastActiveAt.getTime(),
          dateNum(share.expiresAt),
          share.saved,
          JSON.stringify(share.access),
          share.joinCode,
          share.locked,
          share.sizeBytes,
          share.preview ?? null,
          dateNum(share.previewAt),
        ],
      );
      for (const [position, clientId] of share.savedBy.entries())
        await tx.run("INSERT INTO share_saved_by (share_id,client_id,position) VALUES (?,?,?)", [
          share.id,
          clientId,
          position,
        ]);
      for (const [position, clientId] of share.bans.entries())
        await tx.run("INSERT INTO share_bans (share_id,client_id,position) VALUES (?,?,?)", [
          share.id,
          clientId,
          position,
        ]);
    });
  }

  get(id: string) {
    return readShare(this.driver, id, false, this.driver.dialect, true);
  }

  async update(id: string, patch: ShareUpdate) {
    return this.driver.transaction(async (tx) => {
      const current = await readShare(tx, id, true, this.driver.dialect);
      if (!current) return null;
      const clean = <T extends object>(value: T) =>
        Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
      const { access, ...rest } = patch;
      const updated = {
        ...current,
        ...clean(rest),
        access: { ...current.access, ...clean(access ?? {}) },
      };
      await tx.run(
        `UPDATE shares SET title=?, title_search=?, language=?, updated_at=?, last_active_at=?, expires_at=?, join_code=?, locked=?, size_bytes=?, preview=?, preview_at=?, access_json=? WHERE id=?`,
        [
          updated.title,
          updated.title.toLowerCase(),
          updated.language,
          updated.updatedAt.getTime(),
          updated.lastActiveAt.getTime(),
          dateNum(updated.expiresAt),
          updated.joinCode,
          updated.locked,
          updated.sizeBytes,
          updated.preview ?? null,
          dateNum(updated.previewAt),
          JSON.stringify(updated.access),
          id,
        ],
      );
      return readShare(tx, id);
    });
  }

  async delete(id: string) {
    return this.driver.transaction(async (tx) => {
      const rows = await tx.all<{ id: string }>(
        `SELECT id FROM shares WHERE id = ?${supportsForUpdate(this.driver.dialect) ? " FOR UPDATE" : ""}`,
        [id],
      );
      if (!rows.length) return false;
      await deleteShareChildren(tx, id, this.driver.dialect);
      await tx.run("DELETE FROM shares WHERE id = ?", [id]);
      return true;
    });
  }

  async listForClient(clientId: string) {
    const rows = await this.driver.all<ShareRow>(
      `SELECT DISTINCT s.* FROM shares s LEFT JOIN share_saved_by b ON b.share_id=s.id
       WHERE (s.owner_id=? OR b.client_id=?) AND (s.expires_at IS NULL OR s.expires_at>?)
       ORDER BY s.updated_at DESC,s.id ASC`,
      [clientId, clientId, Date.now()],
    );
    return hydrateShares(this.driver, rows);
  }

  async listByLab(labId: string) {
    const rows = await this.driver.all<ShareRow>(
      `SELECT * FROM shares WHERE lab_id=? AND ${visibleShare}`,
      [labId, Date.now()],
    );
    return hydrateShares(this.driver, rows);
  }

  async existing(ids: string[]) {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      if (!batch.length) continue;
      const marks = batch.map(() => "?").join(",");
      const rows = await this.driver.all<{ id: string }>(
        `SELECT id FROM shares WHERE id IN (${marks})`,
        batch,
      );
      for (const row of rows) found.add(row.id);
    }
    return found;
  }

  async addSaved(id: string, clientId: string) {
    return this.driver.transaction(async (tx) => {
      const current = await readShare(tx, id, true, this.driver.dialect);
      if (!current) return null;
      const position = await nextPosition(tx, "share_saved_by", id);
      await tx.run(
        ignoreInsertSql(this.driver.dialect, "share_saved_by", [
          "share_id",
          "client_id",
          "position",
        ]),
        [id, clientId, position],
      );
      await tx.run("UPDATE shares SET saved=TRUE, expires_at=NULL WHERE id=?", [id]);
      return readShare(tx, id);
    });
  }

  async removeSaved(id: string, clientId: string, expiresAtIfUnsaved: Date) {
    return this.driver.transaction(async (tx) => {
      const current = await readShare(tx, id, true, this.driver.dialect);
      if (!current) return null;
      await tx.run("DELETE FROM share_saved_by WHERE share_id=? AND client_id=?", [id, clientId]);
      const left = await savedIds(tx, "share_saved_by", id);
      if (left.length) await tx.run("UPDATE shares SET saved=TRUE WHERE id=?", [id]);
      else
        await tx.run("UPDATE shares SET saved=FALSE, expires_at=? WHERE id=?", [
          expiresAtIfUnsaved.getTime(),
          id,
        ]);
      return readShare(tx, id);
    });
  }

  async touch(id: string, at: Date, expiresAtIfUnsaved: Date, sizeBytes?: number) {
    const rows = await this.driver.run(
      `UPDATE shares SET last_active_at=?,updated_at=?,expires_at=CASE WHEN saved=TRUE THEN expires_at ELSE ? END${sizeBytes === undefined ? "" : ",size_bytes=?"}
       WHERE id=? AND ${visibleShare}`,
      sizeBytes === undefined
        ? [at.getTime(), at.getTime(), expiresAtIfUnsaved.getTime(), id, Date.now()]
        : [at.getTime(), at.getTime(), expiresAtIfUnsaved.getTime(), sizeBytes, id, Date.now()],
    );
    return rows > 0;
  }

  async addBan(id: string, clientId: string) {
    await this.driver.transaction(async (tx) => {
      const current = await readShare(tx, id, true, this.driver.dialect);
      if (!current) return;
      const position = await nextPosition(tx, "share_bans", id);
      await tx.run(
        ignoreInsertSql(this.driver.dialect, "share_bans", ["share_id", "client_id", "position"]),
        [id, clientId, position],
      );
    });
  }

  async removeBan(id: string, clientId: string) {
    await this.driver.run("DELETE FROM share_bans WHERE share_id=? AND client_id=?", [
      id,
      clientId,
    ]);
  }

  async deleteExpired(now: Date) {
    const rows = await this.driver.all<{ id: string }>(
      "SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at < ? ORDER BY id",
      [now.getTime()],
    );
    const removed: string[] = [];
    for (const row of rows) {
      const deleted = await this.driver.transaction(async (tx) => {
        const suffix = supportsForUpdate(this.driver.dialect) ? " FOR UPDATE" : "";
        const [current] = await tx.all<{ expires_at: number | string | null }>(
          `SELECT expires_at FROM shares WHERE id=?${suffix}`,
          [row.id],
        );
        if (!current || current.expires_at === null || Number(current.expires_at) >= now.getTime())
          return false;
        await deleteShareChildren(tx, row.id, this.driver.dialect);
        return (
          (await tx.run(
            "DELETE FROM shares WHERE id=? AND expires_at IS NOT NULL AND expires_at<?",
            [row.id, now.getTime()],
          )) > 0
        );
      });
      if (deleted) removed.push(row.id);
    }
    return removed;
  }
}

class SqlUpdateLog implements UpdateLog {
  constructor(private readonly driver: SqlDriver) {}

  async append(shareId: string, entries: UpdateEntry[], at: Date) {
    if (!entries.length) return;
    try {
      await this.driver.transaction(async (tx) => {
        for (const entry of [...entries].sort((a, b) => a.seq - b.seq))
          await tx.run("INSERT INTO share_updates (share_id,seq,data,at) VALUES (?,?,?,?)", [
            shareId,
            entry.seq,
            blob(entry.data),
            at.getTime(),
          ]);
      });
    } catch (error) {
      const seen = new Set<number>();
      const repeated = entries.find((entry) => seen.has(entry.seq) || !seen.add(entry.seq));
      if (isDuplicate(error)) {
        const existing = await this.driver.all<{ seq: number | string }>(
          "SELECT seq FROM share_updates WHERE share_id=?",
          [shareId],
        );
        const clash =
          entries.find(
            (entry) => seen.has(entry.seq) && existing.some((row) => Number(row.seq) === entry.seq),
          )?.seq ??
          entries.find((entry) => existing.some((row) => Number(row.seq) === entry.seq))?.seq ??
          repeated?.seq ??
          entries[0]?.seq ??
          0;
        throw new DuplicateSeqError(shareId, clash);
      }
      throw error;
    }
  }

  async read(shareId: string, afterSeq: number) {
    const rows = await this.driver.all<{ seq: number | string; data: Uint8Array }>(
      "SELECT seq,data FROM share_updates WHERE share_id=? AND seq>? ORDER BY seq ASC",
      [shareId, afterSeq],
    );
    return rows.map((row) => ({ seq: Number(row.seq), data: bytes(row.data) }));
  }

  async lastSeq(shareId: string) {
    const rows = await this.driver.all<{ seq: number | string | null }>(
      "SELECT MAX(seq) AS seq FROM share_updates WHERE share_id=?",
      [shareId],
    );
    return Number(rows[0]?.seq ?? 0);
  }

  deleteUpTo(shareId: string, seq: number) {
    return this.driver.run("DELETE FROM share_updates WHERE share_id=? AND seq<=?", [shareId, seq]);
  }

  async deleteForShare(shareId: string) {
    await this.driver.run("DELETE FROM share_updates WHERE share_id=?", [shareId]);
  }

  async shareIds() {
    return (
      await this.driver.all<{ share_id: string }>("SELECT DISTINCT share_id FROM share_updates")
    ).map((row) => row.share_id);
  }
}

class SqlSnapshotStore implements SnapshotStore {
  constructor(private readonly driver: SqlDriver) {}

  async put(snapshot: SnapshotRecord) {
    const sql =
      this.driver.dialect === "mysql"
        ? "INSERT INTO share_snapshots (share_id,kind,seq,at,state) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE at=VALUES(at),state=VALUES(state)"
        : "INSERT INTO share_snapshots (share_id,kind,seq,at,state) VALUES (?,?,?,?,?) ON CONFLICT (share_id,kind,seq) DO UPDATE SET at=excluded.at,state=excluded.state";
    await this.driver.run(sql, [
      snapshot.shareId,
      snapshot.kind,
      snapshot.seq,
      snapshot.at.getTime(),
      blob(snapshot.state),
    ]);
  }

  async latest(shareId: string, kind: SnapshotKind) {
    const rows = await this.driver.all<{
      share_id: string;
      kind: SnapshotKind;
      seq: number | string;
      at: number | string;
      state: Uint8Array;
    }>("SELECT * FROM share_snapshots WHERE share_id=? AND kind=? ORDER BY seq DESC LIMIT 1", [
      shareId,
      kind,
    ]);
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async get(shareId: string, kind: SnapshotKind, seq: number) {
    const rows = await this.driver.all<{
      share_id: string;
      kind: SnapshotKind;
      seq: number | string;
      at: number | string;
      state: Uint8Array;
    }>("SELECT * FROM share_snapshots WHERE share_id=? AND kind=? AND seq=?", [shareId, kind, seq]);
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  async list(shareId: string, kind: SnapshotKind) {
    const rows = await this.driver.all<{ seq: number | string; at: number | string }>(
      "SELECT seq,at FROM share_snapshots WHERE share_id=? AND kind=? ORDER BY seq ASC",
      [shareId, kind],
    );
    return rows.map((row) => ({ seq: Number(row.seq), at: new Date(Number(row.at)) }));
  }

  deleteBelow(shareId: string, kind: SnapshotKind, seq: number) {
    return this.driver.run("DELETE FROM share_snapshots WHERE share_id=? AND kind=? AND seq<?", [
      shareId,
      kind,
      seq,
    ]);
  }

  async keepNewest(shareId: string, kind: SnapshotKind, count: number) {
    if (count <= 0)
      return this.driver.run("DELETE FROM share_snapshots WHERE share_id=? AND kind=?", [
        shareId,
        kind,
      ]);
    const rows = await this.driver.all<{ seq: number | string }>(
      "SELECT seq FROM share_snapshots WHERE share_id=? AND kind=? ORDER BY seq DESC LIMIT 1 OFFSET ?",
      [shareId, kind, count - 1],
    );
    if (!rows.length) return 0;
    return this.driver.run("DELETE FROM share_snapshots WHERE share_id=? AND kind=? AND seq<?", [
      shareId,
      kind,
      Number(rows[0]?.seq),
    ]);
  }

  deleteOlderThan(kind: SnapshotKind, before: Date) {
    return this.driver.run("DELETE FROM share_snapshots WHERE kind=? AND at<?", [
      kind,
      before.getTime(),
    ]);
  }

  async deleteForShare(shareId: string) {
    await this.driver.run("DELETE FROM share_snapshots WHERE share_id=?", [shareId]);
  }

  async shareIds() {
    return (
      await this.driver.all<{ share_id: string }>("SELECT DISTINCT share_id FROM share_snapshots")
    ).map((row) => row.share_id);
  }

  private toRecord(row: {
    share_id: string;
    kind: SnapshotKind;
    seq: number | string;
    at: number | string;
    state: Uint8Array;
  }): SnapshotRecord {
    return {
      shareId: row.share_id,
      kind: row.kind,
      seq: Number(row.seq),
      at: new Date(Number(row.at)),
      state: bytes(row.state),
    };
  }
}

const FILE_CHUNK_BYTES = 256 * 1024;

class SqlFileStore implements FileStore {
  constructor(private readonly driver: SqlDriver) {}

  async put(upload: NewUpload) {
    const { data, ...metadata } = upload;
    return this.putStream({
      ...metadata,
      stream: (async function* () {
        yield data;
      })(),
    });
  }

  async putStream(upload: NewUploadStream, maxBytes?: number, maxTotalBytes?: number) {
    const id = randomBytes(12).toString("hex");
    const { stream, name, ...metadata } = upload;
    let size = 0;
    let chunkNo = 0;
    const lease = () => Date.now() + 5 * 60_000;
    await this.driver.run(
      "INSERT INTO uploads (id,name,size,content_type,owner_id,share_id,expires_at,created_at,complete,lease_until) VALUES (?,?,?,?,?,?,?,?,FALSE,?)",
      [
        id,
        name,
        0,
        metadata.contentType,
        metadata.ownerId,
        metadata.shareId ?? null,
        metadata.expiresAt.getTime(),
        Date.now(),
        lease(),
      ],
    );
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      iterator = stream[Symbol.asyncIterator]();
      let filled = 0;
      const pending = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
      const insertChunk = async (chunk: Uint8Array) => {
        const length = chunk.byteLength;
        const number = chunkNo++;
        // The client is awaited outside this replayable, short transaction.
        await this.driver.transaction(async (tx) => {
          if (supportsForUpdate(this.driver.dialect))
            await tx.all("SELECT used_bytes FROM upload_capacity WHERE id=1 FOR UPDATE");
          const changed =
            maxTotalBytes === undefined
              ? await tx.run("UPDATE upload_capacity SET used_bytes=used_bytes+? WHERE id=1", [
                  length,
                ])
              : await tx.run(
                  "UPDATE upload_capacity SET used_bytes=used_bytes+? WHERE id=1 AND used_bytes+?<=?",
                  [length, length, maxTotalBytes],
                );
          if (changed !== 1) throw new StorageCapacityError();
          if (
            (await tx.run(
              "UPDATE uploads SET size=size+?,lease_until=? WHERE id=? AND complete=FALSE AND lease_until>?",
              [length, lease(), id, Date.now()],
            )) !== 1
          )
            throw new Error("Upload is no longer active");
          await tx.run("INSERT INTO upload_chunks (upload_id,chunk_no,data) VALUES (?,?,?)", [
            id,
            number,
            blob(chunk),
          ]);
        });
      };
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Upload idle timeout")), 60_000);
            timer.unref();
          }),
        ]).finally(() => clearTimeout(timer));
        if (part.done) break;
        size += part.value.byteLength;
        if (maxBytes !== undefined && size > maxBytes) throw new FileTooLargeError(maxBytes);
        let offset = 0;
        while (offset < part.value.byteLength) {
          const copied = Math.min(FILE_CHUNK_BYTES - filled, part.value.byteLength - offset);
          pending.set(part.value.subarray(offset, offset + copied), filled);
          filled += copied;
          offset += copied;
          if (filled === FILE_CHUNK_BYTES) {
            await insertChunk(pending);
            filled = 0;
          }
        }
      }
      if (filled) await insertChunk(pending.subarray(0, filled));
      if (
        (await this.driver.run(
          "UPDATE uploads SET complete=TRUE WHERE id=? AND complete=FALSE AND lease_until>?",
          [id, Date.now()],
        )) !== 1
      )
        throw new Error("Upload is no longer active");
    } catch (error) {
      // return() may itself wait for a stalled generator; never retain a DB lock while cancelling.
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => undefined);
      await this.delete(id);
      throw error;
    }

    return {
      id,
      name,
      size,
      contentType: metadata.contentType,
      ownerId: metadata.ownerId,
      ...(metadata.shareId ? { shareId: metadata.shareId } : {}),
      expiresAt: metadata.expiresAt,
    };
  }

  async get(id: string) {
    const meta = await this.meta(id);
    if (!meta) return null;
    const data = new Uint8Array(meta.size);
    let offset = 0;
    for await (const chunk of this.chunks(id, meta.size)) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== meta.size) throw new Error("Stored upload chunks do not match metadata size");
    return { meta, data };
  }

  async meta(id: string) {
    const rows = await this.driver.all<
      SqlRow & {
        id: string;
        name: string;
        size: number | string;
        content_type: string | null;
        owner_id: string;
        share_id: string | null;
        expires_at: number | string;
      }
    >("SELECT * FROM uploads WHERE id=? AND complete=TRUE", [id]);
    const row = rows[0];
    return row
      ? ({
          id: row.id,
          name: row.name,
          size: Number(row.size),
          contentType: row.content_type,
          ownerId: row.owner_id,
          ...(row.share_id ? { shareId: row.share_id } : {}),
          expiresAt: new Date(Number(row.expires_at)),
        } satisfies UploadRecord)
      : null;
  }

  async openDownload(id: string) {
    const meta = await this.meta(id);
    if (!meta) return null;
    return { meta, stream: Readable.from(this.chunks(id, meta.size)) };
  }

  private async *chunks(id: string, size: number) {
    let expected = 0;
    let total = 0;
    for (;;) {
      const rows = await this.driver.all<{ chunk_no: number | string; data: Uint8Array }>(
        "SELECT chunk_no,data FROM upload_chunks WHERE upload_id=? AND chunk_no>=? ORDER BY chunk_no LIMIT 8",
        [id, expected],
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (Number(row.chunk_no) !== expected++)
          throw new Error("Stored upload chunks are incomplete");
        total += row.data.byteLength;
        if (total > size) throw new Error("Stored upload chunks exceed metadata size");
        yield row.data;
      }
    }
    if (total !== size) throw new Error("Stored upload chunks do not match metadata size");
  }

  async delete(id: string) {
    return (await this.deleteMatching("id=?", [id])) > 0;
  }

  async deleteForShare(shareId: string) {
    return this.deleteMatching("share_id=?", [shareId]);
  }

  async deleteExpired(now: Date) {
    return this.deleteMatching(
      "(complete=TRUE AND expires_at<?) OR (complete=FALSE AND lease_until<?)",
      [now.getTime(), now.getTime()],
    );
  }

  async shareIds() {
    return (
      await this.driver.all<{ share_id: string }>(
        "SELECT DISTINCT share_id FROM uploads WHERE share_id IS NOT NULL",
      )
    ).map((row) => row.share_id);
  }

  private async deleteMatching(where: string, values: unknown[]) {
    return this.driver.transaction((tx) => deleteUploads(tx, this.driver.dialect, where, values));
  }
}

class SqlLabStore implements LabStore {
  constructor(private readonly driver: SqlDriver) {}

  async create(lab: LabRecord) {
    await this.driver.run(
      "INSERT INTO labs (id,title,owner_id,join_code,template_share_id,locked,students_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        lab.id,
        lab.title,
        lab.ownerId,
        lab.joinCode,
        lab.templateShareId,
        lab.locked,
        JSON.stringify(lab.students),
        lab.createdAt.getTime(),
        lab.expiresAt.getTime(),
      ],
    );
  }

  get(id: string) {
    return readLab(this.driver, id);
  }

  async update(id: string, patch: LabUpdate) {
    return this.driver.transaction(async (tx) => {
      const current = await readLab(tx, id, true, this.driver.dialect);
      if (!current) return null;
      const updated = { ...current, ...patch };
      await tx.run("UPDATE labs SET title=?,locked=?,template_share_id=? WHERE id=?", [
        updated.title,
        updated.locked,
        updated.templateShareId,
        id,
      ]);
      return readLab(tx, id);
    });
  }

  async addStudent(id: string, student: LabStudent) {
    return this.driver.transaction(async (tx) => {
      const lab = await readLab(tx, id, true, this.driver.dialect);
      if (!lab) return null;
      const students = [
        ...lab.students.filter((item) => item.clientId !== student.clientId),
        student,
      ];
      await tx.run("UPDATE labs SET students_json=? WHERE id=?", [JSON.stringify(students), id]);
      return readLab(tx, id);
    });
  }

  async delete(id: string) {
    return (await this.driver.run("DELETE FROM labs WHERE id=?", [id])) > 0;
  }

  async deleteExpired(now: Date) {
    return this.driver.run("DELETE FROM labs WHERE expires_at<?", [now.getTime()]);
  }
}

class SqlLabelStore implements LabelStore {
  constructor(private readonly driver: SqlDriver) {}

  async get(clientId: string, shareId: string) {
    const rows = await this.driver.all<{
      client_id: string;
      share_id: string;
      folder: string | null;
      tags_json: string;
      updated_at: number | string;
    }>("SELECT * FROM share_labels WHERE client_id=? AND share_id=?", [clientId, shareId]);
    return rows[0] ? this.record(rows[0]) : null;
  }

  async set(clientId: string, shareId: string, labels: ShareLabels, at: Date) {
    const sql =
      this.driver.dialect === "mysql"
        ? "INSERT INTO share_labels (client_id,share_id,folder,tags_json,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE folder=VALUES(folder),tags_json=VALUES(tags_json),updated_at=VALUES(updated_at)"
        : "INSERT INTO share_labels (client_id,share_id,folder,tags_json,updated_at) VALUES (?,?,?,?,?) ON CONFLICT (client_id,share_id) DO UPDATE SET folder=excluded.folder,tags_json=excluded.tags_json,updated_at=excluded.updated_at";
    await this.driver.run(sql, [
      clientId,
      shareId,
      labels.folder,
      JSON.stringify(labels.tags),
      at.getTime(),
    ]);
    return { clientId, shareId, folder: labels.folder, tags: [...labels.tags], updatedAt: at };
  }

  async delete(clientId: string, shareId: string) {
    return (
      (await this.driver.run("DELETE FROM share_labels WHERE client_id=? AND share_id=?", [
        clientId,
        shareId,
      ])) > 0
    );
  }

  async listForClient(clientId: string) {
    const rows = await this.driver.all<{
      client_id: string;
      share_id: string;
      folder: string | null;
      tags_json: string;
      updated_at: number | string;
    }>("SELECT * FROM share_labels WHERE client_id=?", [clientId]);
    return rows.map((row) => this.record(row));
  }

  async deleteForShare(shareId: string) {
    return this.driver.run("DELETE FROM share_labels WHERE share_id=?", [shareId]);
  }

  async shareIds() {
    return (
      await this.driver.all<{ share_id: string }>("SELECT DISTINCT share_id FROM share_labels")
    ).map((row) => row.share_id);
  }

  async deleteInaccessible() {
    return this.driver.run(
      `DELETE FROM share_labels WHERE NOT EXISTS (
      SELECT 1 FROM shares s WHERE s.id=share_labels.share_id
      AND (s.expires_at IS NULL OR s.expires_at>?)
      AND (s.owner_id=share_labels.client_id OR EXISTS (
        SELECT 1 FROM share_saved_by b WHERE b.share_id=s.id AND b.client_id=share_labels.client_id)))`,
      [Date.now()],
    );
  }

  async clientIds() {
    return (
      await this.driver.all<{ client_id: string }>("SELECT DISTINCT client_id FROM share_labels")
    ).map((row) => row.client_id);
  }

  private record(row: {
    client_id: string;
    share_id: string;
    folder: string | null;
    tags_json: string;
    updated_at: number | string;
  }): ShareLabelRecord {
    return {
      clientId: row.client_id,
      shareId: row.share_id,
      folder: row.folder,
      tags: json(row.tags_json),
      updatedAt: new Date(Number(row.updated_at)),
    };
  }
}

class SqlSettingsStore implements SettingsStore {
  constructor(private readonly driver: SqlDriver) {}

  async get() {
    const rows = await this.driver.all<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE id=?",
      [SETTINGS_DOC_ID],
    );
    return rows[0] ? settingsSchema.parse(json(rows[0].value_json)) : defaultSettings();
  }

  async put(settings: Settings) {
    const sql =
      this.driver.dialect === "mysql"
        ? "INSERT INTO settings (id,value_json) VALUES (?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)"
        : "INSERT INTO settings (id,value_json) VALUES (?,?) ON CONFLICT (id) DO UPDATE SET value_json=excluded.value_json";
    await this.driver.run(sql, [SETTINGS_DOC_ID, JSON.stringify(settings)]);
  }
}

class SqlAuditStore {
  constructor(private readonly driver: SqlDriver) {}

  async append(entry: AuditRecord) {
    const id = randomUUID();
    await this.driver.run(
      "INSERT INTO audit (id,at,actor,ip,action,share_id,detail_json) VALUES (?,?,?,?,?,?,?)",
      [
        id,
        entry.at.getTime(),
        entry.actor,
        entry.ip,
        entry.action,
        entry.shareId ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      ],
    );
  }

  async list({ limit, before }: AuditQuery) {
    const rows = await this.driver.all<{
      at: number | string;
      actor: string;
      ip: string;
      action: string;
      share_id: string | null;
      detail_json: string | null;
    }>(
      `SELECT at,actor,ip,action,share_id,detail_json FROM audit ${before ? "WHERE at<?" : ""} ORDER BY at DESC LIMIT ?`,
      before ? [before.getTime(), Math.max(0, limit)] : [Math.max(0, limit)],
    );
    return rows.map((row) => ({
      at: new Date(Number(row.at)),
      actor: row.actor,
      ip: row.ip,
      action: row.action,
      ...(row.share_id ? { shareId: row.share_id } : {}),
      ...(row.detail_json == null ? {} : { detail: json(row.detail_json) }),
    }));
  }

  deleteOlderThan(before: Date) {
    return this.driver.run("DELETE FROM audit WHERE at<?", [before.getTime()]);
  }
}

class SqlDiagnosticsStore {
  constructor(private readonly driver: SqlDriver) {}

  async replace(snapshot: DiagnosticSnapshot) {
    const clean = scrubDiagnosticSnapshot(snapshot);
    if (!clean) return;
    const sql =
      this.driver.dialect === "mysql"
        ? "INSERT INTO diagnostics (slot,value_json) VALUES (?,?) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json)"
        : "INSERT INTO diagnostics (slot,value_json) VALUES (?,?) ON CONFLICT (slot) DO UPDATE SET value_json=excluded.value_json";
    await this.driver.run(sql, [clean.slot, JSON.stringify(clean)]);
  }

  async list() {
    const rows = await this.driver.all<{ value_json: string }>(
      "SELECT value_json FROM diagnostics LIMIT 16",
    );
    return rows.map((row) => json<DiagnosticSnapshot>(row.value_json));
  }
}

export function createSqlStores(driver: SqlDriver): Stores {
  return {
    diagnostics: new SqlDiagnosticsStore(driver),
    shares: new SqlShareStore(driver),
    updates: new SqlUpdateLog(driver),
    snapshots: new SqlSnapshotStore(driver),
    files: new SqlFileStore(driver),
    labs: new SqlLabStore(driver),
    labels: new SqlLabelStore(driver),
    settings: new SqlSettingsStore(driver),
    audit: new SqlAuditStore(driver),
  };
}
