import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AuditRecord,
  type LabRecord,
  SETTINGS_DOC_ID,
  type Settings,
  type ShareLabelRecord,
  type ShareRecord,
  type SnapshotRecord,
  type UploadRecord,
} from "@gachipad/shared";
import {
  Binary,
  type ClientSession,
  type Db,
  type Document,
  GridFSBucket,
  type GridFSFile,
  ObjectId,
} from "mongodb";
import { COLLECTIONS, UPLOADS_BUCKET } from "../mongo.js";
import { splitShare } from "./members.js";
import type { TransferBackend, TransferItem, TransferRecord } from "./types.js";

const PAGE_SIZE = 128;
const binaryBytes = (value: Binary) => Uint8Array.from(value.buffer.subarray(0, value.position));
const binary = (value: Uint8Array) => new Binary(Uint8Array.from(value));

type ShareDocument = Omit<ShareRecord, "id"> & { _id: string };
type LabDocument = Omit<LabRecord, "id"> & { _id: string };
type LabelDocument = ShareLabelRecord & { _id: string };
type UpdateDocument = { _id?: ObjectId; shareId: string; seq: number; data: Binary; at: Date };
type SnapshotDocument = Omit<SnapshotRecord, "state"> & { state: Binary };
type SettingsDocument = Settings & { _id: string };
type AuditDocument = AuditRecord & { _id?: ObjectId | string };

function isTransactionUnsupported(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if ("code" in error && Number(error.code) === 20) return true;
  if ("originalError" in error && isTransactionUnsupported(error.originalError, seen)) return true;
  return "cause" in error && isTransactionUnsupported(error.cause, seen);
}

export function createMongoTransferBackend(db: Db): TransferBackend {
  const bucket = new GridFSBucket(db, { bucketName: UPLOADS_BUCKET });
  const files = db.collection(`${UPLOADS_BUCKET}.files`);
  const quota = db.collection<{ _id: string; bytes: number }>("storage_quotas");
  let supportsTransactions: boolean | undefined;

  const writeBatch = async (work: (session?: ClientSession) => Promise<void>) => {
    if (supportsTransactions === false) return work();
    const session = db.client.startSession();
    session.startTransaction();
    try {
      await work(session);
      await session.commitTransaction();
      supportsTransactions = true;
    } catch (error) {
      await session.abortTransaction().catch(() => undefined);
      if (supportsTransactions === undefined && isTransactionUnsupported(error)) {
        supportsTransactions = false;
        await work();
      } else {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  };

  return {
    async *exportAll(liveAt: Date): AsyncIterable<TransferItem> {
      const liveShare = { $or: [{ expiresAt: null }, { expiresAt: { $gte: liveAt } }] };
      // Keeps records whose share is still live; a missing localField matches no share.
      const withLiveShare = (localField: string) => ({
        $lookup: {
          from: COLLECTIONS.shares,
          localField,
          foreignField: "_id",
          pipeline: [{ $match: liveShare }, { $project: { _id: 1 } }],
          as: "liveShare",
        },
      });

      const shareCursor = db
        .collection<ShareDocument>(COLLECTIONS.shares)
        .find(liveShare, { batchSize: PAGE_SIZE });
      try {
        for await (const { _id, ...record } of shareCursor) {
          yield* splitShare({ id: _id, ...record });

          const updateCursor = db
            .collection<UpdateDocument>(COLLECTIONS.updates)
            .find({ shareId: _id }, { batchSize: PAGE_SIZE })
            .sort({ seq: 1 });
          try {
            for await (const row of updateCursor)
              yield {
                kind: "updates",
                record: {
                  shareId: row.shareId,
                  seq: row.seq,
                  data: binaryBytes(row.data),
                  at: row.at,
                },
              };
          } finally {
            await updateCursor.close();
          }

          const snapshotsForShare = db
            .collection<SnapshotDocument>(COLLECTIONS.snapshots)
            .find({ shareId: _id }, { batchSize: PAGE_SIZE })
            .sort({ kind: 1, seq: 1 });
          try {
            for await (const row of snapshotsForShare)
              yield {
                kind: "snapshots",
                record: {
                  shareId: row.shareId,
                  kind: row.kind,
                  seq: row.seq,
                  at: row.at,
                  state: binaryBytes(row.state),
                },
              };
          } finally {
            await snapshotsForShare.close();
          }
        }
      } finally {
        await shareCursor.close();
      }

      const labCursor = db
        .collection<LabDocument>(COLLECTIONS.labs)
        .find({ expiresAt: { $gte: liveAt } }, { batchSize: PAGE_SIZE });
      try {
        for await (const { _id, ...record } of labCursor)
          yield { kind: "labs", record: { id: _id, ...record } };
      } finally {
        await labCursor.close();
      }

      const labelCursor = db
        .collection<LabelDocument>(COLLECTIONS.labels)
        .aggregate<LabelDocument & { liveShare: unknown }>(
          [
            withLiveShare("shareId"),
            { $match: { "liveShare.0": { $exists: true } } },
            { $project: { liveShare: 0 } },
          ],
          { batchSize: PAGE_SIZE },
        );
      try {
        for await (const { _id: _labelId, liveShare: _liveShare, ...record } of labelCursor)
          yield { kind: "labels", record };
      } finally {
        await labelCursor.close();
      }

      const settingCursor = db
        .collection<SettingsDocument>(COLLECTIONS.settings)
        .find({ _id: SETTINGS_DOC_ID }, { batchSize: 1 });
      try {
        const row = await settingCursor.next();
        if (row) {
          const { _id: _settingsId, ...record } = row;
          yield { kind: "settings", record };
        }
      } finally {
        await settingCursor.close();
      }

      const auditCursor = db
        .collection<AuditDocument>(COLLECTIONS.audit)
        .find({}, { batchSize: PAGE_SIZE });
      try {
        for await (const row of auditCursor) {
          const { _id, ...record } = row;
          const audit: AuditRecord = {
            at: record.at,
            actor: record.actor,
            ip: record.ip,
            action: record.action,
            ...(record.shareId === undefined ? {} : { shareId: record.shareId }),
            ...(record.detail === undefined ? {} : { detail: record.detail }),
          };
          yield {
            kind: "audit",
            id: _id instanceof ObjectId ? _id.toHexString() : String(_id),
            record: audit,
          };
        }
      } finally {
        await auditCursor.close();
      }

      const uploadCursor = files.aggregate<GridFSFile>(
        [
          { $match: { "metadata.expiresAt": { $gte: liveAt } } },
          withLiveShare("metadata.shareId"),
          {
            $match: {
              $or: [
                { "metadata.shareId": { $exists: false } },
                { "liveShare.0": { $exists: true } },
              ],
            },
          },
          { $project: { liveShare: 0 } },
        ],
        { batchSize: PAGE_SIZE },
      );
      try {
        for await (const file of uploadCursor) {
          const metadata = file.metadata as {
            ownerId: string;
            shareId?: string;
            expiresAt: Date;
            contentType?: string | null;
          };
          const record: UploadRecord = {
            id: file._id instanceof ObjectId ? file._id.toHexString() : String(file._id),
            name: file.filename,
            size: file.length,
            contentType: metadata.contentType ?? null,
            ownerId: metadata.ownerId,
            ...(metadata.shareId === undefined ? {} : { shareId: metadata.shareId }),
            expiresAt: metadata.expiresAt,
          };
          const id = file._id;
          yield {
            kind: "uploads",
            record,
            createdAt: file.uploadDate,
            chunks: (async function* () {
              for await (const chunk of bucket.openDownloadStream(id)) yield chunk as Uint8Array;
            })(),
          };
        }
      } finally {
        await uploadCursor.close();
      }
    },

    async countLive(liveAt: Date) {
      return {
        shares: await db
          .collection(COLLECTIONS.shares)
          .countDocuments({ $or: [{ expiresAt: null }, { expiresAt: { $gte: liveAt } }] }),
        labs: await db.collection(COLLECTIONS.labs).countDocuments({ expiresAt: { $gte: liveAt } }),
      };
    },

    async importBatch(items: readonly TransferRecord[]) {
      if (!items.length) return;
      await writeBatch(async (session) => {
        const options = session ? { session } : undefined;
        const insert = async (collection: string, docs: Document[]) => {
          if (docs.length) await db.collection(collection).insertMany(docs, options);
        };
        await insert(
          COLLECTIONS.shares,
          items
            .filter((item) => item.kind === "shares")
            .map((item) => {
              if (item.kind !== "shares") return {};
              const { id, ...record } = item.record;
              return { _id: id, ...record };
            }),
        );
        for (const item of items)
          if (item.kind === "shareMembers") {
            const { shareId, list, offset, clientIds } = item.record;
            await db
              .collection<ShareDocument>(COLLECTIONS.shares)
              .updateOne(
                { _id: shareId },
                { $push: { [list]: { $each: clientIds, $position: offset } } },
                options,
              );
          }
        await insert(
          COLLECTIONS.updates,
          items
            .filter((item) => item.kind === "updates")
            .map((item) => {
              if (item.kind !== "updates") return {};
              return {
                shareId: item.record.shareId,
                seq: item.record.seq,
                data: binary(item.record.data),
                at: item.record.at,
              };
            }),
        );
        await insert(
          COLLECTIONS.snapshots,
          items
            .filter((item) => item.kind === "snapshots")
            .map((item) => {
              if (item.kind !== "snapshots") return {};
              return { ...item.record, state: binary(item.record.state) };
            }),
        );
        await insert(
          COLLECTIONS.labs,
          items
            .filter((item) => item.kind === "labs")
            .map((item) => {
              if (item.kind !== "labs") return {};
              const { id, ...record } = item.record;
              return { _id: id, ...record };
            }),
        );
        await insert(
          COLLECTIONS.labels,
          items
            .filter((item) => item.kind === "labels")
            .map((item) => {
              if (item.kind !== "labels") return {};
              return { _id: `${item.record.clientId}:${item.record.shareId}`, ...item.record };
            }),
        );
        await insert(
          COLLECTIONS.settings,
          items
            .filter((item) => item.kind === "settings")
            .map((item) => {
              if (item.kind !== "settings") return {};
              return { _id: SETTINGS_DOC_ID, ...item.record };
            }),
        );
        await insert(
          COLLECTIONS.audit,
          items
            .filter((item) => item.kind === "audit")
            .map((item) => {
              if (item.kind !== "audit") return {};
              return { _id: item.id, ...item.record };
            }),
        );
      });
    },

    async importUpload(record, createdAt, source) {
      if (!/^[0-9a-f]{24}$/i.test(record.id))
        throw new Error("MongoDB upload IDs must be 24 hexadecimal characters");
      const id = new ObjectId(record.id);
      const target = bucket.openUploadStreamWithId(id, record.name, {
        metadata: {
          ownerId: record.ownerId,
          ...(record.shareId === undefined ? {} : { shareId: record.shareId }),
          expiresAt: record.expiresAt,
          contentType: record.contentType,
        },
      });
      await pipeline(Readable.from(source), target);
      await files.updateOne({ _id: id }, { $set: { uploadDate: createdAt } });
    },

    async isEmpty() {
      const collections = [
        COLLECTIONS.shares,
        COLLECTIONS.updates,
        COLLECTIONS.snapshots,
        COLLECTIONS.labs,
        COLLECTIONS.labels,
        COLLECTIONS.settings,
        COLLECTIONS.audit,
        "diagnostics",
        `${UPLOADS_BUCKET}.files`,
        `${UPLOADS_BUCKET}.chunks`,
      ];
      for (const collection of collections)
        if (await db.collection(collection).findOne({}, { projection: { _id: 1 } })) return false;
      if (await quota.findOne({ _id: { $ne: "uploads" } }, { projection: { _id: 1 } }))
        return false;
      const uploads = await quota.findOne({ _id: "uploads" });
      return !uploads || uploads.bytes === 0;
    },

    async recomputeCounters() {
      const [usage] = await files
        .aggregate<{ bytes: number }>([{ $group: { _id: null, bytes: { $sum: "$length" } } }])
        .toArray();
      await quota.updateOne(
        { _id: "uploads" },
        { $set: { bytes: usage?.bytes ?? 0 } },
        { upsert: true },
      );
    },

    async uploadCounter() {
      return (await quota.findOne({ _id: "uploads" }))?.bytes ?? Number.NaN;
    },
  };
}
