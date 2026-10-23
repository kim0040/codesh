import { Readable } from "node:stream";
import {
  type AuditRecord,
  defaultSettings,
  type LabRecord,
  type LabStudent,
  type Settings,
  type ShareRecord,
  type SnapshotKind,
  type SnapshotRecord,
  type UploadRecord,
} from "@codesh/shared";
import {
  type AuditQuery,
  type AuditStore,
  DuplicateSeqError,
  type FileStore,
  FileTooLargeError,
  type LabStore,
  type LabUpdate,
  type NewUpload,
  type NewUploadStream,
  type SettingsStore,
  type ShareStore,
  type ShareUpdate,
  type SnapshotStore,
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
  private readonly shares = new Map<string, ShareRecord>();

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
    if (!share) return;
    share.lastActiveAt = new Date(at);
    share.updatedAt = new Date(at);
    if (!share.saved) share.expiresAt = new Date(expiresAtIfUnsaved);
    if (sizeBytes !== undefined) share.sizeBytes = sizeBytes;
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
  private readonly files = new Map<string, { meta: UploadRecord; data: Uint8Array }>();

  async put(upload: NewUpload) {
    const { data, ...rest } = upload;
    const meta = { ...rest, id: crypto.randomUUID(), size: data.byteLength };
    this.files.set(meta.id, { meta: copy(meta), data: data.slice() });
    return copy(meta);
  }

  async putStream(upload: NewUploadStream, maxBytes?: number) {
    const { stream, ...rest } = upload;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
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

class MemorySettingsStore implements SettingsStore {
  private settings: Settings | null = null;

  async get() {
    return this.settings ? copy(this.settings) : defaultSettings();
  }

  async put(settings: Settings) {
    this.settings = copy(settings);
  }
}

class MemoryAuditStore implements AuditStore {
  private entries: AuditRecord[] = [];

  async append(entry: AuditRecord) {
    this.entries.push(copy(entry));
  }

  async list({ limit, before }: AuditQuery) {
    return this.entries
      .filter((e) => !before || e.at < before)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit)
      .map(copy);
  }

  async deleteOlderThan(before: Date) {
    const count = this.entries.length;
    this.entries = this.entries.filter((e) => e.at >= before);
    return count - this.entries.length;
  }
}

export function createMemoryStores(): Stores {
  return {
    shares: new MemoryShareStore(),
    updates: new MemoryUpdateLog(),
    snapshots: new MemorySnapshotStore(),
    files: new MemoryFileStore(),
    labs: new MemoryLabStore(),
    settings: new MemorySettingsStore(),
    audit: new MemoryAuditStore(),
  };
}
