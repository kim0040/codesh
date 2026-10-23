import type {
  AuditRecord,
  LabRecord,
  LabStudent,
  Settings,
  ShareRecord,
  SnapshotKind,
  SnapshotRecord,
  UploadRecord,
} from "@codesh/shared";

/** Persistence contract of docs/ARCHITECTURE.md §5. Only implementations import a database driver. */

/** Fields a caller may change on a share; everything else has a dedicated method. */
export type ShareUpdate = Partial<
  Pick<
    ShareRecord,
    | "title"
    | "language"
    | "updatedAt"
    | "lastActiveAt"
    | "expiresAt"
    | "access"
    | "joinCode"
    | "locked"
    | "sizeBytes"
  >
>;

export interface ShareStore {
  create(share: ShareRecord): Promise<void>;
  get(id: string): Promise<ShareRecord | null>;
  /** Returns the updated share, or null if it does not exist. */
  update(id: string, patch: ShareUpdate): Promise<ShareRecord | null>;
  delete(id: string): Promise<boolean>;
  /** Shares owned by or saved by the client, newest `updatedAt` first. */
  listForClient(clientId: string): Promise<ShareRecord[]>;
  listByLab(labId: string): Promise<ShareRecord[]>;
  /** The subset of `ids` that still exist (used by the sweeper). */
  existing(ids: string[]): Promise<Set<string>>;
  /** Adds to `savedBy`, sets `saved` and clears `expiresAt`. */
  addSaved(id: string, clientId: string): Promise<ShareRecord | null>;
  /**
   * Removes from `savedBy`. When nobody has it saved any more, `saved` becomes false and
   * `expiresAt` becomes `expiresAtIfUnsaved`.
   */
  removeSaved(id: string, clientId: string, expiresAtIfUnsaved: Date): Promise<ShareRecord | null>;
  addBan(id: string, clientId: string): Promise<void>;
  removeBan(id: string, clientId: string): Promise<void>;
  /** Removes shares whose `expiresAt` is before `now` and returns their ids (MongoDB uses a TTL index). */
  deleteExpired(now: Date): Promise<string[]>;
}

export interface UpdateEntry {
  seq: number;
  data: Uint8Array;
}

/** Append-only log of Yjs updates since the last compaction. */
export interface UpdateLog {
  /** Throws `DuplicateSeqError` when a `{shareId, seq}` pair already exists. */
  append(shareId: string, entries: UpdateEntry[], at: Date): Promise<void>;
  /** Entries with `seq > afterSeq`, ascending. */
  read(shareId: string, afterSeq: number): Promise<UpdateEntry[]>;
  /** Highest stored seq, 0 when the log is empty. */
  lastSeq(shareId: string): Promise<number>;
  /** Deletes entries with `seq <= seq` and returns how many were removed. */
  deleteUpTo(shareId: string, seq: number): Promise<number>;
  deleteForShare(shareId: string): Promise<void>;
  /** Every share id that has at least one entry (used by the sweeper). */
  shareIds(): Promise<string[]>;
}

export class DuplicateSeqError extends Error {
  constructor(
    readonly shareId: string,
    readonly seq: number,
  ) {
    super(`duplicate update seq ${seq} for share ${shareId}`);
    this.name = "DuplicateSeqError";
  }
}

export interface SnapshotMeta {
  seq: number;
  at: Date;
}

export interface SnapshotStore {
  put(snapshot: SnapshotRecord): Promise<void>;
  /** The snapshot of `kind` with the highest seq. */
  latest(shareId: string, kind: SnapshotKind): Promise<SnapshotRecord | null>;
  get(shareId: string, kind: SnapshotKind, seq: number): Promise<SnapshotRecord | null>;
  /** Metadata only, ascending by seq. */
  list(shareId: string, kind: SnapshotKind): Promise<SnapshotMeta[]>;
  /** Deletes snapshots of `kind` with `seq < seq`. */
  deleteBelow(shareId: string, kind: SnapshotKind, seq: number): Promise<number>;
  /** Retention: deletes snapshots of `kind` older than `before`. */
  deleteOlderThan(kind: SnapshotKind, before: Date): Promise<number>;
  deleteForShare(shareId: string): Promise<void>;
  shareIds(): Promise<string[]>;
}

export type NewUpload = Omit<UploadRecord, "id" | "size"> & { data: Uint8Array };

/** GridFS bucket `uploads`. */
export interface FileStore {
  put(upload: NewUpload): Promise<UploadRecord>;
  get(id: string): Promise<{ meta: UploadRecord; data: Uint8Array } | null>;
  delete(id: string): Promise<boolean>;
  deleteForShare(shareId: string): Promise<number>;
  /** Deletes uploads whose `expiresAt` is before `now` and returns how many were removed. */
  deleteExpired(now: Date): Promise<number>;
  /** Every share id referenced by an upload (used by the sweeper). */
  shareIds(): Promise<string[]>;
}

export type LabUpdate = Partial<Pick<LabRecord, "title" | "locked" | "templateShareId">>;

export interface LabStore {
  create(lab: LabRecord): Promise<void>;
  get(id: string): Promise<LabRecord | null>;
  update(id: string, patch: LabUpdate): Promise<LabRecord | null>;
  /** Adds the student, or replaces the entry with the same `clientId`. */
  addStudent(id: string, student: LabStudent): Promise<LabRecord | null>;
  delete(id: string): Promise<boolean>;
  deleteExpired(now: Date): Promise<number>;
}

export interface SettingsStore {
  /** Defaults when nothing is stored yet. */
  get(): Promise<Settings>;
  put(settings: Settings): Promise<void>;
}

export interface AuditQuery {
  limit: number;
  before?: Date;
}

export interface AuditStore {
  append(entry: AuditRecord): Promise<void>;
  /** Newest first. */
  list(query: AuditQuery): Promise<AuditRecord[]>;
  deleteOlderThan(before: Date): Promise<number>;
}

export interface Stores {
  shares: ShareStore;
  updates: UpdateLog;
  snapshots: SnapshotStore;
  files: FileStore;
  labs: LabStore;
  settings: SettingsStore;
  audit: AuditStore;
}
