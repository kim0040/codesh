import type {
  AuditRecord,
  LabRecord,
  Settings,
  ShareLabelRecord,
  ShareRecord,
  SnapshotRecord,
  UploadRecord,
} from "@gachipad/shared";

export const TRANSFER_KINDS = [
  "shares",
  "updates",
  "snapshots",
  "uploads",
  "labs",
  "labels",
  "settings",
  "audit",
] as const;

export type TransferKind = (typeof TRANSFER_KINDS)[number];

/** Further savedBy or bans entries of a share, starting at list index `offset`. */
export interface ShareMembers {
  shareId: string;
  list: "savedBy" | "bans";
  offset: number;
  clientIds: string[];
}

export type TransferRecord =
  | { kind: "shares"; record: ShareRecord }
  | { kind: "shareMembers"; record: ShareMembers }
  | { kind: "updates"; record: { shareId: string; seq: number; data: Uint8Array; at: Date } }
  | { kind: "snapshots"; record: SnapshotRecord }
  | { kind: "labs"; record: LabRecord }
  | { kind: "labels"; record: ShareLabelRecord }
  | { kind: "settings"; record: Settings }
  | { kind: "audit"; id: string; record: AuditRecord };

export interface TransferUpload {
  kind: "uploads";
  record: UploadRecord;
  createdAt: Date;
  chunks: AsyncIterable<Uint8Array>;
}

export type AuditItem = Extract<TransferRecord, { kind: "audit" }>;
export type TransferItem = TransferRecord | TransferUpload;
export type TransferCounts = Record<TransferKind, number>;

/** Backend-only persistence operations used by the offline database copier. */
export interface TransferBackend {
  /**
   * Every record that outlives `cutoff`: shares without expiry or expiring after it, labs and
   * completed uploads expiring after it. Everything else, and the updates, snapshots, labels and
   * uploads of a share left out or missing, is skipped. A share's savedBy and bans lists may
   * continue in `shareMembers` items.
   */
  exportAll(cutoff: Date): AsyncIterable<TransferItem>;
  /** The audit entries exportAll yields, read alone to check their details before the copy. */
  exportAudit(): AsyncIterable<AuditItem>;
  /** Shares and labs exportAll yields: the kinds a database TTL index can delete. */
  countLive(cutoff: Date): Promise<{ shares: number; labs: number }>;
  importBatch(items: readonly TransferRecord[]): Promise<void>;
  importUpload(
    record: UploadRecord,
    createdAt: Date,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void>;
  isEmpty(): Promise<boolean>;
  recomputeCounters(): Promise<void>;
  /** Stored upload byte counter; undefined when the backend keeps none, NaN when it is broken. */
  uploadCounter(): Promise<number | undefined>;
}
