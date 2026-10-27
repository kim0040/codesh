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

export type TransferRecord =
  | { kind: "shares"; record: ShareRecord }
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
  exportAll(): AsyncIterable<TransferItem>;
  importBatch(items: readonly TransferRecord[]): Promise<void>;
  importUpload(
    record: UploadRecord,
    createdAt: Date,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void>;
  isEmpty(): Promise<boolean>;
  recomputeCounters(): Promise<void>;
}
