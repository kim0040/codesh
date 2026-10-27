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

export type TransferItem = TransferRecord | TransferUpload;
export type TransferCounts = Record<TransferKind, number>;

/** Backend-only persistence operations used by the offline database copier. */
export interface TransferBackend {
  /**
   * Every live record. Shares and labs that expired before `liveAt`, completed uploads that
   * expired before it, and the updates, snapshots, labels and uploads of an expired or missing
   * share are left out. A share's savedBy and bans lists may continue in `shareMembers` items.
   */
  exportAll(liveAt: Date): AsyncIterable<TransferItem>;
  /** Live shares and labs: the kinds a database TTL index can delete while the copy runs. */
  countLive(liveAt: Date): Promise<{ shares: number; labs: number }>;
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
