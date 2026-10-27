import { Readable } from "node:stream";
import {
  type AuditRecord,
  type DiagnosticSnapshot,
  defaultSettings,
  type LabRecord,
  type LabStudent,
  type Settings,
  type ShareLabelRecord,
  type ShareLabels,
  type ShareRecord,
  type SnapshotKind,
  type SnapshotRecord,
  scrubDiagnosticSnapshot,
  type UploadRecord,
} from "@gachipad/shared";
import { registerTransferBackend } from "./transfer/registry.js";
import type { TransferBackend, TransferItem, TransferRecord } from "./transfer/types.js";
import {
  type AuditQuery,
  type AuditStore,
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
} from "./types.js";

/** In-memory stores for tests. Values are copied on the way in and out, like a real database. */

const copy = <T>(value: T): T => structuredClone(value);

/** Same as MongoDB's `defined`: an `undefined` field means "leave as is". */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

class MemoryShareStore implements ShareStore {
  async adminList(search: string, before?: Date, beforeId?: string) {
    return [...this.shares.values()]
      .filter(
        (s) =>
          (!s.expiresAt || s.expiresAt > new Date()) &&
          s.title.toLowerCase().includes(search.toLowerCase()) &&
          (!before ||
            s.createdAt < before ||
            (s.createdAt.getTime() === before.getTime() &&
              beforeId !== undefined &&
              s.id < beforeId)),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, 100)
      .map((s) =>
        copy({
          id: s.id,
          title: s.title,
          language: s.language,
          saved: s.saved,
          ownerId: s.ownerId,
          ...(s.labId ? { labId: s.labId } : {}),
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expiresAt: s.expiresAt,
          sizeBytes: s.sizeBytes,
          locked: s.locked,
        }),
      );
  }
  async adminSummary() {
    const now = Date.now();
    const shares = [...this.shares.values()].filter(
      (s) => !s.expiresAt || s.expiresAt.getTime() > now,
    );
    const activity = Array<number>(24).fill(0);
    for (const s of shares) {
      const hour = Math.floor((now - s.createdAt.getTime()) / 3600000);
      if (hour >= 0 && hour < 24) activity[23 - hour] = (activity[23 - hour] ?? 0) + 1;
    }
    return { shares: shares.length, activity };
  }

  private readonly shares = new Map<string, ShareRecord>();

  *transferRecords(): Iterable<ShareRecord> {
    for (const share of this.shares.values()) yield copy(share);
  }

  transferImport(share: ShareRecord) {
    this.shares.set(share.id, copy(share));
  }

  get transferSize() {
    return this.shares.size;
  }

  async create(share: ShareRecord) {
    if (this.shares.has(share.id)) throw new Error(`share ${share.id} already exists`);
    this.shares.set(share.id, copy(share));
  }

  async get(id: string) {
    const share = this.shares.get(id);
    return share ? copy(share) : null;
  }

  async update(id: string, patch: ShareUpdate) {
    const share = this.shares.get(id);
    if (!share) return null;
    const { access, ...rest } = copy(patch);
    Object.assign(share, defined(rest));
    if (access) Object.assign(share.access, defined(access));
    return copy(share);
  }

  async delete(id: string) {
    return this.shares.delete(id);
  }

  async listForClient(clientId: string) {
    return [...this.shares.values()]
      .filter((s) => s.ownerId === clientId || s.savedBy.includes(clientId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(copy);
  }

  async listByLab(labId: string) {
    return [...this.shares.values()].filter((s) => s.labId === labId).map(copy);
  }

  async existing(ids: string[]) {
    return new Set(ids.filter((id) => this.shares.has(id)));
  }

  async addSaved(id: string, clientId: string) {
    const share = this.shares.get(id);
    if (!share) return null;
    if (!share.savedBy.includes(clientId)) share.savedBy.push(clientId);
    share.saved = true;
    share.expiresAt = null;
    return copy(share);
  }

  async removeSaved(id: string, clientId: string, expiresAtIfUnsaved: Date) {
    const share = this.shares.get(id);
    if (!share) return null;
    share.savedBy = share.savedBy.filter((c) => c !== clientId);
    if (share.savedBy.length === 0) {
      share.saved = false;
      share.expiresAt = new Date(expiresAtIfUnsaved);
    }
    return copy(share);
  }

  async touch(id: string, at: Date, expiresAtIfUnsaved: Date, sizeBytes?: number) {
    const share = this.shares.get(id);
    if (!share) return false;
    share.lastActiveAt = new Date(at);
    share.updatedAt = new Date(at);
    if (!share.saved) share.expiresAt = new Date(expiresAtIfUnsaved);
    if (sizeBytes !== undefined) share.sizeBytes = sizeBytes;
    return true;
  }

  async addBan(id: string, clientId: string) {
    const share = this.shares.get(id);
    if (share && !share.bans.includes(clientId)) share.bans.push(clientId);
  }

  async removeBan(id: string, clientId: string) {
    const share = this.shares.get(id);
    if (share) share.bans = share.bans.filter((c) => c !== clientId);
  }

  async deleteExpired(now: Date) {
    const expired = [...this.shares.values()]
      .filter((s) => s.expiresAt !== null && s.expiresAt < now)
      .map((s) => s.id);
    for (const id of expired) this.shares.delete(id);
    return expired;
  }
}

class MemoryUpdateLog implements UpdateLog {
  private readonly logs = new Map<string, Map<number, { data: Uint8Array; at: Date }>>();

  *transferRecords() {
    for (const [shareId, log] of this.logs) {
      for (const [seq, entry] of log)
        yield { shareId, seq, data: entry.data.slice(), at: new Date(entry.at) };
    }
  }

  transferImport(record: { shareId: string; seq: number; data: Uint8Array; at: Date }) {
    const log = this.logs.get(record.shareId) ?? new Map();
    log.set(record.seq, { data: record.data.slice(), at: new Date(record.at) });
    this.logs.set(record.shareId, log);
  }

  get transferSize() {
    let count = 0;
    for (const log of this.logs.values()) count += log.size;
    return count;
  }

  async append(shareId: string, entries: UpdateEntry[], at: Date) {
    const log = this.logs.get(shareId) ?? new Map();
    // All-or-nothing, like insertMany with a unique index.
    for (const { seq } of entries) if (log.has(seq)) throw new DuplicateSeqError(shareId, seq);
    for (const { seq, data } of entries) log.set(seq, { data: data.slice(), at: new Date(at) });
    this.logs.set(shareId, log);
  }

  async read(shareId: string, afterSeq: number) {
    const log = this.logs.get(shareId);
    if (!log) return [];
    return [...log.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b)
      .map(([seq, { data }]) => ({ seq, data: data.slice() }));
  }

  async lastSeq(shareId: string) {
    const log = this.logs.get(shareId);
    return log && log.size > 0 ? Math.max(...log.keys()) : 0;
  }

  async deleteUpTo(shareId: string, seq: number) {
    const log = this.logs.get(shareId);
    if (!log) return 0;
    let removed = 0;
    for (const key of [...log.keys()]) {
      if (key <= seq) {
        log.delete(key);
        removed++;
      }
    }
    if (log.size === 0) this.logs.delete(shareId);
    return removed;
  }

  async deleteForShare(shareId: string) {
    this.logs.delete(shareId);
  }

  async shareIds() {
    return [...this.logs.keys()];
  }
}

class MemorySnapshotStore implements SnapshotStore {
  private snapshots: SnapshotRecord[] = [];

  *transferRecords(): Iterable<SnapshotRecord> {
    for (const snapshot of this.snapshots) yield copy(snapshot);
  }

  transferImport(snapshot: SnapshotRecord) {
    this.snapshots.push(copy(snapshot));
  }

  get transferSize() {
    return this.snapshots.length;
  }

  async put(snapshot: SnapshotRecord) {
    this.snapshots = this.snapshots.filter(
      (s) =>
        !(s.shareId === snapshot.shareId && s.kind === snapshot.kind && s.seq === snapshot.seq),
    );
    this.snapshots.push(copy(snapshot));
  }

  async latest(shareId: string, kind: SnapshotKind) {
    const matching = this.snapshots.filter((s) => s.shareId === shareId && s.kind === kind);
    const top = matching.reduce<(typeof matching)[number] | null>(
      (best, s) => (best === null || s.seq > best.seq ? s : best),
      null,
    );
    return top ? copy(top) : null;
  }

  async get(shareId: string, kind: SnapshotKind, seq: number) {
    const found = this.snapshots.find(
      (s) => s.shareId === shareId && s.kind === kind && s.seq === seq,
    );
    return found ? copy(found) : null;
  }

  async list(shareId: string, kind: SnapshotKind) {
    return this.snapshots
      .filter((s) => s.shareId === shareId && s.kind === kind)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ seq: s.seq, at: new Date(s.at) }));
  }

  async deleteBelow(shareId: string, kind: SnapshotKind, seq: number) {
    return this.removeWhere((s) => s.shareId === shareId && s.kind === kind && s.seq < seq);
  }

  async keepNewest(shareId: string, kind: SnapshotKind, count: number) {
    const kept = new Set(
      this.snapshots
        .filter((s) => s.shareId === shareId && s.kind === kind)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, count),
    );
    return this.removeWhere((s) => s.shareId === shareId && s.kind === kind && !kept.has(s));
  }

  async deleteOlderThan(kind: SnapshotKind, before: Date) {
    return this.removeWhere((s) => s.kind === kind && s.at < before);
  }

  async deleteForShare(shareId: string) {
    this.removeWhere((s) => s.shareId === shareId);
  }

  async shareIds() {
    return [...new Set(this.snapshots.map((s) => s.shareId))];
  }

  private removeWhere(predicate: (s: SnapshotRecord) => boolean) {
    const before = this.snapshots.length;
    this.snapshots = this.snapshots.filter((s) => !predicate(s));
    return before - this.snapshots.length;
  }
}

class MemoryFileStore implements FileStore {
  private readonly files = new Map<
    string,
    { meta: UploadRecord; data: Uint8Array; createdAt: Date }
  >();
  private reserved = 0;

  async put(upload: NewUpload) {
    const { data, ...rest } = upload;
    const meta = { ...rest, id: crypto.randomUUID(), size: data.byteLength };
    this.files.set(meta.id, { meta: copy(meta), data: data.slice(), createdAt: new Date() });
    return copy(meta);
  }

  async *transferRecords(): AsyncIterable<{
    record: UploadRecord;
    createdAt: Date;
    chunks: AsyncIterable<Uint8Array>;
  }> {
    for (const file of this.files.values()) {
      const data = file.data;
      yield {
        record: copy(file.meta),
        createdAt: new Date(file.createdAt),
        chunks: (async function* () {
          for (let offset = 0; offset < data.byteLength; offset += 256 * 1024)
            yield data.subarray(offset, Math.min(data.byteLength, offset + 256 * 1024));
        })(),
      };
    }
  }

  async transferImport(record: UploadRecord, createdAt: Date, chunks: AsyncIterable<Uint8Array>) {
    const data = new Uint8Array(record.size);
    let offset = 0;
    for await (const chunk of chunks) {
      if (offset + chunk.byteLength > data.byteLength) throw new Error("Invalid upload size");
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== data.byteLength) throw new Error("Invalid upload size");
    this.files.set(record.id, { meta: copy(record), data, createdAt: new Date(createdAt) });
  }

  get transferSize() {
    return this.files.size;
  }

  async putStream(upload: NewUploadStream, maxBytes?: number, maxTotalBytes?: number) {
    const { stream, ...rest } = upload;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const used = [...this.files.values()].reduce((total, file) => total + file.meta.size, 0);
        if (maxTotalBytes !== undefined && used + this.reserved + chunk.byteLength > maxTotalBytes)
          throw new StorageCapacityError();
        this.reserved += chunk.byteLength;
        size += chunk.byteLength;
        if (maxBytes !== undefined && size > maxBytes) throw new FileTooLargeError(maxBytes);
        chunks.push(chunk.slice());
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return this.put({ ...rest, data });
    } finally {
      this.reserved -= size;
    }
  }

  async get(id: string) {
    const file = this.files.get(id);
    return file ? { meta: copy(file.meta), data: file.data.slice() } : null;
  }

  async meta(id: string) {
    const file = this.files.get(id);
    return file ? copy(file.meta) : null;
  }

  async openDownload(id: string) {
    const file = this.files.get(id);
    if (!file) return null;
    return { meta: copy(file.meta), stream: Readable.from([Buffer.from(file.data)]) };
  }

  async delete(id: string) {
    return this.files.delete(id);
  }

  async deleteForShare(shareId: string) {
    return this.removeWhere((f) => f.meta.shareId === shareId);
  }

  async deleteExpired(now: Date) {
    return this.removeWhere((f) => f.meta.expiresAt < now);
  }

  async shareIds() {
    const ids = [...this.files.values()].flatMap((f) => (f.meta.shareId ? [f.meta.shareId] : []));
    return [...new Set(ids)];
  }

  private removeWhere(predicate: (f: { meta: UploadRecord }) => boolean) {
    let removed = 0;
    for (const [id, file] of [...this.files]) {
      if (predicate(file)) {
        this.files.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

class MemoryLabStore implements LabStore {
  private readonly labs = new Map<string, LabRecord>();

  *transferRecords(): Iterable<LabRecord> {
    for (const lab of this.labs.values()) yield copy(lab);
  }

  transferImport(lab: LabRecord) {
    this.labs.set(lab.id, copy(lab));
  }

  get transferSize() {
    return this.labs.size;
  }

  async create(lab: LabRecord) {
    if (this.labs.has(lab.id)) throw new Error(`lab ${lab.id} already exists`);
    this.labs.set(lab.id, copy(lab));
  }

  async get(id: string) {
    const lab = this.labs.get(id);
    return lab ? copy(lab) : null;
  }

  async update(id: string, patch: LabUpdate) {
    const lab = this.labs.get(id);
    if (!lab) return null;
    Object.assign(lab, patch);
    return copy(lab);
  }

  async addStudent(id: string, student: LabStudent) {
    const lab = this.labs.get(id);
    if (!lab) return null;
    lab.students = [...lab.students.filter((s) => s.clientId !== student.clientId), copy(student)];
    return copy(lab);
  }

  async delete(id: string) {
    return this.labs.delete(id);
  }

  async deleteExpired(now: Date) {
    let removed = 0;
    for (const [id, lab] of [...this.labs]) {
      if (lab.expiresAt < now) {
        this.labs.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

class MemoryLabelStore implements LabelStore {
  private readonly entries = new Map<string, ShareLabelRecord>();

  *transferRecords(): Iterable<ShareLabelRecord> {
    for (const entry of this.entries.values()) yield copy(entry);
  }

  transferImport(entry: ShareLabelRecord) {
    this.entries.set(this.key(entry.clientId, entry.shareId), copy(entry));
  }

  get transferSize() {
    return this.entries.size;
  }

  private key = (clientId: string, shareId: string) => `${clientId}:${shareId}`;

  async get(clientId: string, shareId: string) {
    const entry = this.entries.get(this.key(clientId, shareId));
    return entry ? copy(entry) : null;
  }

  async set(clientId: string, shareId: string, labels: ShareLabels, at: Date) {
    const entry: ShareLabelRecord = {
      clientId,
      shareId,
      folder: labels.folder,
      tags: [...labels.tags],
      updatedAt: at,
    };
    this.entries.set(this.key(clientId, shareId), entry);
    return copy(entry);
  }

  async delete(clientId: string, shareId: string) {
    return this.entries.delete(this.key(clientId, shareId));
  }

  async listForClient(clientId: string) {
    return [...this.entries.values()].filter((entry) => entry.clientId === clientId).map(copy);
  }

  async deleteForShare(shareId: string) {
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.shareId === shareId) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async shareIds() {
    return [...new Set([...this.entries.values()].map((entry) => entry.shareId))];
  }

  async clientIds() {
    return [...new Set([...this.entries.values()].map((entry) => entry.clientId))];
  }
}

class MemorySettingsStore implements SettingsStore {
  private settings: Settings | null = null;

  transferRecord() {
    return this.settings ? copy(this.settings) : null;
  }

  transferImport(settings: Settings) {
    this.settings = copy(settings);
  }

  async get() {
    return this.settings ? copy(this.settings) : defaultSettings();
  }

  async put(settings: Settings) {
    this.settings = copy(settings);
  }
}

class MemoryAuditStore implements AuditStore {
  private entries: Array<{ id: string; record: AuditRecord }> = [];

  *transferRecords() {
    for (const entry of this.entries) yield copy(entry);
  }

  transferImport(entry: { id: string; record: AuditRecord }) {
    this.entries.push(copy(entry));
  }

  get transferSize() {
    return this.entries.length;
  }

  async append(entry: AuditRecord) {
    this.entries.push({ id: crypto.randomUUID(), record: copy(entry) });
  }

  async list({ limit, before }: AuditQuery) {
    return this.entries
      .filter(({ record }) => !before || record.at < before)
      .sort((a, b) => b.record.at.getTime() - a.record.at.getTime())
      .slice(0, limit)
      .map(({ record }) => copy(record));
  }

  async deleteOlderThan(before: Date) {
    const count = this.entries.length;
    this.entries = this.entries.filter(({ record }) => record.at >= before);
    return count - this.entries.length;
  }
}

class MemoryDiagnosticsStore {
  private readonly slots = new Map<string, DiagnosticSnapshot>();
  get transferSize() {
    return this.slots.size;
  }
  async replace(snapshot: DiagnosticSnapshot) {
    const clean = scrubDiagnosticSnapshot(snapshot);
    if (clean) this.slots.set(clean.slot, copy(clean));
  }
  async list() {
    return copy([...this.slots.values()]);
  }
}
export function createMemoryStores(): Stores {
  const diagnostics = new MemoryDiagnosticsStore();
  const shares = new MemoryShareStore();
  const updates = new MemoryUpdateLog();
  const snapshots = new MemorySnapshotStore();
  const files = new MemoryFileStore();
  const labs = new MemoryLabStore();
  const labels = new MemoryLabelStore();
  const settings = new MemorySettingsStore();
  const audit = new MemoryAuditStore();
  const stores: Stores = {
    diagnostics,
    shares,
    updates,
    snapshots,
    files,
    labs,
    labels,
    settings,
    audit,
  };
  const transfer: TransferBackend = {
    async *exportAll(): AsyncIterable<TransferItem> {
      for (const record of shares.transferRecords()) yield { kind: "shares", record };
      for (const record of updates.transferRecords()) yield { kind: "updates", record };
      for (const record of snapshots.transferRecords()) yield { kind: "snapshots", record };
      for await (const item of files.transferRecords()) yield { kind: "uploads", ...item };
      for (const record of labs.transferRecords()) yield { kind: "labs", record };
      for (const record of labels.transferRecords()) yield { kind: "labels", record };
      const setting = settings.transferRecord();
      if (setting) yield { kind: "settings", record: setting };
      for (const entry of audit.transferRecords())
        yield { kind: "audit", id: entry.id, record: entry.record };
    },
    async importBatch(items: readonly TransferRecord[]) {
      for (const item of items) {
        switch (item.kind) {
          case "shares":
            shares.transferImport(item.record);
            break;
          case "updates":
            updates.transferImport(item.record);
            break;
          case "snapshots":
            snapshots.transferImport(item.record);
            break;
          case "labs":
            labs.transferImport(item.record);
            break;
          case "labels":
            labels.transferImport(item.record);
            break;
          case "settings":
            settings.transferImport(item.record);
            break;
          case "audit":
            audit.transferImport({ id: item.id, record: item.record });
            break;
        }
      }
    },
    importUpload: (record, createdAt, chunks) => files.transferImport(record, createdAt, chunks),
    async isEmpty() {
      return (
        shares.transferSize +
          updates.transferSize +
          snapshots.transferSize +
          files.transferSize +
          labs.transferSize +
          labels.transferSize +
          audit.transferSize +
          diagnostics.transferSize ===
          0 && !settings.transferRecord()
      );
    },
    async recomputeCounters() {},
  };
  return registerTransferBackend(stores, transfer);
}
