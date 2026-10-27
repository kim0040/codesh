import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  Binary,
  type Collection,
  type Db,
  type Document,
  type Filter,
  GridFSBucket,
  MongoBulkWriteError,
  MongoClient,
  ObjectId,
} from "mongodb";
import { createMongoTransferBackend } from "./transfer/mongo.js";
import { registerTransferBackend } from "./transfer/registry.js";
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

/** MongoDB implementation of the stores (§5). The only module that imports the driver. */

export type { Db } from "mongodb";

export const COLLECTIONS = {
  shares: "shares",
  updates: "share_updates",
  snapshots: "share_snapshots",
  labs: "labs",
  labels: "share_labels",
  settings: "settings",
  audit: "audit",
} as const;

export const UPLOADS_BUCKET = "uploads";

const DUPLICATE_KEY = 11000;
const MAINTENANCE_BATCH = 256;

type ShareDoc = Omit<ShareRecord, "id"> & { _id: string };
type LabDoc = Omit<LabRecord, "id"> & { _id: string };
type LabelDoc = ShareLabelRecord & { _id: string };
type UpdateDoc = { _id?: ObjectId; shareId: string; seq: number; data: Binary; at: Date };
type SnapshotDoc = Omit<SnapshotRecord, "state"> & { state: Binary };
type SettingsDoc = Settings & { _id: string };
type AuditDoc = AuditRecord & { _id?: ObjectId };
type UploadMetadata = {
  ownerId: string;
  shareId?: string;
  expiresAt: Date;
  contentType: string | null;
};

/** The driver stores `undefined` as null; optional fields must be absent instead. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function toBytes(value: Binary): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.buffer.subarray(0, value.position));
}

function toBinary(bytes: Uint8Array): Binary {
  return new Binary(Uint8Array.from(bytes));
}

function fromShareDoc({ _id, ...rest }: ShareDoc): ShareRecord {
  return { id: _id, ...rest };
}

function fromSnapshotDoc({ shareId, seq, at, kind, state }: SnapshotDoc): SnapshotRecord {
  return { shareId, seq, at, kind, state: toBytes(state) };
}

function fromLabDoc({ _id, ...rest }: LabDoc): LabRecord {
  return { id: _id, ...rest };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === DUPLICATE_KEY
  );
}

class MongoShareStore implements ShareStore {
  async adminList(search: string, before?: Date, beforeId?: string) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const docs = await this.shares
      .find(
        {
          $and: [
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
            ...(search ? [{ title: { $regex: escaped, $options: "i" } }] : []),
            ...(before
              ? [
                  {
                    $or: [
                      { createdAt: { $lt: before } },
                      ...(beforeId ? [{ createdAt: before, _id: { $lt: beforeId } }] : []),
                    ],
                  },
                ]
              : []),
          ],
        },
        {
          projection: {
            _id: 1,
            title: 1,
            language: 1,
            saved: 1,
            ownerId: 1,
            labId: 1,
            createdAt: 1,
            lastActiveAt: 1,
            expiresAt: 1,
            sizeBytes: 1,
            locked: 1,
          },
        },
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .toArray();
    return docs.map((s) => ({
      id: s._id,
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
    }));
  }
  async adminSummary() {
    const now = Date.now();
    const rows = await this.shares
      .aggregate<{ _id: number; count: number }>([
        { $match: { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(now) } }] } },
        {
          $group: {
            _id: { $floor: { $divide: [{ $subtract: [new Date(now), "$createdAt"] }, 3600000] } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const activity = Array<number>(24).fill(0);
    for (const row of rows) if (row._id >= 0 && row._id < 24) activity[23 - row._id] = row.count;
    return { shares: rows.reduce((n, r) => n + r.count, 0), activity };
  }

  constructor(private readonly shares: Collection<ShareDoc>) {}

  async create({ id, ...rest }: ShareRecord) {
    await this.shares.insertOne(defined({ _id: id, ...rest }));
  }

  async get(id: string) {
    const doc = await this.shares.findOne({ _id: id });
    return doc ? fromShareDoc(doc) : null;
  }

  async update(id: string, patch: ShareUpdate) {
    // Dotted `access.*` paths, so a concurrent update of another access field is not overwritten.
    const { access, ...rest } = patch;
    const set: Record<string, unknown> = defined(rest);
    for (const [field, value] of Object.entries(defined(access ?? {}))) {
      set[`access.${field}`] = value;
    }
    if (Object.keys(set).length === 0) return this.get(id);
    const doc = await this.shares.findOneAndUpdate(
      { _id: id },
      { $set: set },
      { returnDocument: "after" },
    );
    return doc ? fromShareDoc(doc) : null;
  }

  async delete(id: string) {
    return (await this.shares.deleteOne({ _id: id })).deletedCount === 1;
  }

  async listForClient(clientId: string) {
    const docs = await this.shares
      .find({ $or: [{ ownerId: clientId }, { savedBy: clientId }] })
      .sort({ updatedAt: -1, _id: 1 })
      .toArray();
    return docs.map(fromShareDoc);
  }

  async listByLab(labId: string) {
    return (await this.shares.find({ labId }).toArray()).map(fromShareDoc);
  }

  async existing(ids: string[]) {
    if (ids.length === 0) return new Set<string>();
    const docs = await this.shares
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(docs.map((d) => d._id));
  }

  async addSaved(id: string, clientId: string) {
    const doc = await this.shares.findOneAndUpdate(
      { _id: id },
      { $addToSet: { savedBy: clientId }, $set: { saved: true, expiresAt: null } },
      { returnDocument: "after" },
    );
    return doc ? fromShareDoc(doc) : null;
  }

  async removeSaved(id: string, clientId: string, expiresAtIfUnsaved: Date) {
    // One pipeline update so the "nobody saved it any more" decision sees the same array it changes.
    const doc = await this.shares.findOneAndUpdate(
      { _id: id },
      [
        {
          $set: {
            savedBy: { $filter: { input: "$savedBy", cond: { $ne: ["$$this", clientId] } } },
          },
        },
        {
          $set: {
            saved: { $gt: [{ $size: "$savedBy" }, 0] },
            expiresAt: {
              $cond: [{ $gt: [{ $size: "$savedBy" }, 0] }, "$expiresAt", expiresAtIfUnsaved],
            },
          },
        },
      ],
      { returnDocument: "after" },
    );
    return doc ? fromShareDoc(doc) : null;
  }

  async touch(id: string, at: Date, expiresAtIfUnsaved: Date, sizeBytes?: number) {
    const result = await this.shares.updateOne({ _id: id }, [
      {
        $set: {
          lastActiveAt: at,
          updatedAt: at,
          expiresAt: { $cond: ["$saved", "$expiresAt", expiresAtIfUnsaved] },
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        },
      },
    ]);
    return result.matchedCount > 0;
  }

  async addBan(id: string, clientId: string) {
    await this.shares.updateOne({ _id: id }, { $addToSet: { bans: clientId } });
  }

  async removeBan(id: string, clientId: string) {
    await this.shares.updateOne({ _id: id }, { $pull: { bans: clientId } });
  }

  async deleteExpired(now: Date) {
    const filter = { expiresAt: { $ne: null, $lt: now } };
    const ids = (await this.shares.find(filter, { projection: { _id: 1 } }).toArray()).map(
      (d) => d._id,
    );
    if (ids.length > 0) await this.shares.deleteMany({ ...filter, _id: { $in: ids } });
    return ids;
  }
}

class MongoUpdateLog implements UpdateLog {
  constructor(private readonly updates: Collection<UpdateDoc>) {}

  async append(shareId: string, entries: UpdateEntry[], at: Date) {
    if (entries.length === 0) return;
    const docs = entries.map(({ seq, data }) => ({
      _id: new ObjectId(),
      shareId,
      seq,
      data: toBinary(data),
      at,
    }));
    try {
      await this.updates.insertMany(docs, { ordered: true });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // All-or-nothing like the contract says: remove what this batch inserted before the clash.
      const inserted = error instanceof MongoBulkWriteError ? error.insertedCount : 0;
      if (inserted > 0) {
        await this.updates.deleteMany({ _id: { $in: docs.slice(0, inserted).map((d) => d._id) } });
      }
      const clash = docs[inserted]?.seq ?? entries[0]?.seq ?? 0;
      throw new DuplicateSeqError(shareId, clash);
    }
  }

  async read(shareId: string, afterSeq: number) {
    const docs = await this.updates
      .find({ shareId, seq: { $gt: afterSeq } }, { projection: { _id: 0, seq: 1, data: 1 } })
      .sort({ seq: 1 })
      .toArray();
    return docs.map((d) => ({ seq: d.seq, data: toBytes(d.data) }));
  }

  async lastSeq(shareId: string) {
    const doc = await this.updates.findOne(
      { shareId },
      { sort: { seq: -1 }, projection: { seq: 1 } },
    );
    return doc?.seq ?? 0;
  }

  async deleteUpTo(shareId: string, seq: number) {
    return (await this.updates.deleteMany({ shareId, seq: { $lte: seq } })).deletedCount;
  }

  async deleteForShare(shareId: string) {
    await this.updates.deleteMany({ shareId });
  }

  async shareIds() {
    return (await this.updates.distinct("shareId")) as string[];
  }
}

class MongoSnapshotStore implements SnapshotStore {
  constructor(private readonly snapshots: Collection<SnapshotDoc>) {}

  async put(snapshot: SnapshotRecord) {
    const { shareId, kind, seq } = snapshot;
    await this.snapshots.replaceOne(
      { shareId, kind, seq },
      { ...snapshot, state: toBinary(snapshot.state) },
      { upsert: true },
    );
  }

  async latest(shareId: string, kind: SnapshotKind) {
    const doc = await this.snapshots.findOne(
      { shareId, kind },
      { sort: { seq: -1 }, projection: { _id: 0 } },
    );
    return doc ? fromSnapshotDoc(doc) : null;
  }

  async get(shareId: string, kind: SnapshotKind, seq: number) {
    const doc = await this.snapshots.findOne({ shareId, kind, seq }, { projection: { _id: 0 } });
    return doc ? fromSnapshotDoc(doc) : null;
  }

  async list(shareId: string, kind: SnapshotKind) {
    const docs = await this.snapshots
      .find({ shareId, kind }, { projection: { _id: 0, seq: 1, at: 1 } })
      .sort({ seq: 1 })
      .toArray();
    return docs.map((d) => ({ seq: d.seq, at: d.at }));
  }

  async deleteBelow(shareId: string, kind: SnapshotKind, seq: number) {
    return (await this.snapshots.deleteMany({ shareId, kind, seq: { $lt: seq } })).deletedCount;
  }

  async keepNewest(shareId: string, kind: SnapshotKind, count: number) {
    if (count <= 0) return (await this.snapshots.deleteMany({ shareId, kind })).deletedCount;
    const [oldestKept] = await this.snapshots
      .find({ shareId, kind }, { projection: { _id: 0, seq: 1 } })
      .sort({ seq: -1 })
      .skip(count - 1)
      .limit(1)
      .toArray();
    if (!oldestKept) return 0;
    return (await this.snapshots.deleteMany({ shareId, kind, seq: { $lt: oldestKept.seq } }))
      .deletedCount;
  }

  async deleteOlderThan(kind: SnapshotKind, before: Date) {
    return (await this.snapshots.deleteMany({ kind, at: { $lt: before } })).deletedCount;
  }

  async deleteForShare(shareId: string) {
    await this.snapshots.deleteMany({ shareId });
  }

  async shareIds() {
    return (await this.snapshots.distinct("shareId")) as string[];
  }
}

class MongoFileStore implements FileStore {
  private readonly bucket: GridFSBucket;

  private ledgerReady: Promise<void> | null = null;
  private readonly ledger: Collection<{ _id: string; bytes: number }>;

  constructor(private readonly db: Db) {
    this.ledger = db.collection("storage_quotas");
    this.bucket = new GridFSBucket(db, { bucketName: UPLOADS_BUCKET });
  }

  async put(upload: NewUpload) {
    const { data, ...rest } = upload;
    return this.putStream({
      ...rest,
      stream: (async function* () {
        yield data;
      })(),
    });
  }

  private async readyLedger(): Promise<void> {
    if (!this.ledgerReady)
      this.ledgerReady = (async () => {
        if (await this.ledger.findOne({ _id: "uploads" })) return;
        const [usage] = await this.db
          .collection(`${UPLOADS_BUCKET}.files`)
          .aggregate<{ bytes: number }>([{ $group: { _id: null, bytes: { $sum: "$length" } } }])
          .toArray();
        try {
          await this.ledger.updateOne(
            { _id: "uploads" },
            { $setOnInsert: { bytes: usage?.bytes ?? 0 } },
            { upsert: true },
          );
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
        }
      })().catch((error) => {
        this.ledgerReady = null;
        throw error;
      });
    await this.ledgerReady;
  }

  async putStream(upload: NewUploadStream, maxBytes?: number, maxTotalBytes?: number) {
    await this.readyLedger();
    const { stream, name, ...rest } = upload;
    const metadata: UploadMetadata = defined({
      ownerId: rest.ownerId,
      shareId: rest.shareId,
      expiresAt: rest.expiresAt,
      contentType: rest.contentType,
    });
    const target = this.bucket.openUploadStream(name, { metadata });
    let size = 0;
    let tooLarge = false;
    let reserved = 0;
    const ledger = this.ledger;
    async function* charged() {
      for await (const chunk of stream) {
        const accepted = await ledger.updateOne(
          {
            _id: "uploads",
            ...(maxTotalBytes === undefined
              ? {}
              : { bytes: { $lte: maxTotalBytes - chunk.byteLength } }),
          },
          { $inc: { bytes: chunk.byteLength } },
        );
        if (accepted.matchedCount === 0) throw new StorageCapacityError();
        reserved += chunk.byteLength;
        yield chunk;
      }
    }
    const limit = new Transform({
      transform(chunk: Uint8Array, _encoding, done) {
        size += chunk.byteLength;
        if (maxBytes !== undefined && size > maxBytes) tooLarge = true;
        // Past the limit the rest is drained, not written; the caller bounds the request size.
        done(null, tooLarge ? undefined : chunk);
      },
    });
    try {
      await pipeline(charged(), limit, target);
    } catch (error) {
      // Drops the chunks written so far; the file document is only written when the stream ends.
      const cleaned = await target.abort().then(
        () => true,
        () => false,
      );
      if (cleaned) await ledger.updateOne({ _id: "uploads" }, { $inc: { bytes: -reserved } });
      throw error;
    }
    if (tooLarge) {
      // The upload finished cleanly, so no chunk insert is still in flight when it is deleted.
      await this.bucket.delete(target.id as ObjectId);
      await ledger.updateOne({ _id: "uploads" }, { $inc: { bytes: -reserved } });
      throw new FileTooLargeError(maxBytes as number);
    }
    return this.toRecord(target.id as ObjectId, name, size, metadata);
  }

  async meta(id: string) {
    const _id = this.parseId(id);
    if (!_id) return null;
    const file = await this.bucket.find({ _id }).next();
    if (!file) return null;
    return this.toRecord(_id, file.filename, file.length, file.metadata as UploadMetadata);
  }

  async openDownload(id: string) {
    const _id = this.parseId(id);
    const meta = _id ? await this.meta(id) : null;
    if (!_id || !meta) return null;
    return { meta, stream: this.bucket.openDownloadStream(_id) };
  }

  async get(id: string) {
    const _id = this.parseId(id);
    if (!_id) return null;
    const file = await this.bucket.find({ _id }).next();
    if (!file) return null;
    // Copies each chunk into place as it arrives, so the file is held in memory once.
    const data = new Uint8Array(file.length);
    let offset = 0;
    for await (const chunk of this.bucket.openDownloadStream(_id)) {
      const bytes = chunk as Uint8Array;
      if (offset + bytes.byteLength > data.byteLength) throw new Error(`upload ${id} is corrupt`);
      data.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return {
      meta: this.toRecord(_id, file.filename, file.length, file.metadata as UploadMetadata),
      data,
    };
  }

  async delete(id: string) {
    const _id = this.parseId(id);
    if (!_id) return false;
    return (await this.deleteBatch([_id])) === 1;
  }

  async deleteForShare(shareId: string) {
    return this.deleteForShares([shareId]);
  }

  async deleteForShares(shareIds: string[], renew?: () => Promise<void>) {
    return this.deleteWhere({ "metadata.shareId": { $in: shareIds } }, renew);
  }

  async deleteExpired(now: Date, renew?: () => Promise<void>) {
    return this.deleteWhere({ "metadata.expiresAt": { $lt: now } }, renew);
  }

  async shareIds() {
    return this.db
      .collection(`${UPLOADS_BUCKET}.files`)
      .distinct<string>("metadata.shareId", { "metadata.shareId": { $exists: true } });
  }

  private async deleteBatch(ids: ObjectId[]) {
    if (ids.length === 0) return 0;
    await this.readyLedger();
    const files = this.db.collection(`${UPLOADS_BUCKET}.files`);
    const claimed: Array<{ _id: ObjectId; length: number }> = [];
    let failure: unknown;
    let failed = false;
    for (let offset = 0; offset < ids.length; offset += 8) {
      // Claim each file atomically, so competing cleanup/download-delete requests cannot debit it twice.
      const results = await Promise.allSettled(
        ids
          .slice(offset, offset + 8)
          .map((_id) => files.findOneAndDelete({ _id }, { projection: { _id: 1, length: 1 } })),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failed = true;
          failure = result.reason;
        } else if (result.value) claimed.push(result.value as { _id: ObjectId; length: number });
      }
      if (failed) break;
    }
    if (claimed.length > 0) {
      await this.db
        .collection(`${UPLOADS_BUCKET}.chunks`)
        .deleteMany({ files_id: { $in: claimed.map((file) => file._id) } });
      await this.ledger.updateOne(
        { _id: "uploads" },
        { $inc: { bytes: -claimed.reduce((sum, file) => sum + file.length, 0) } },
      );
    }
    if (failed) throw failure;
    return claimed.length;
  }

  private async deleteWhere(filter: Record<string, unknown>, renew?: () => Promise<void>) {
    const cursor = this.bucket.find(filter, {
      projection: { _id: 1 },
      batchSize: MAINTENANCE_BATCH,
    });
    let count = 0;
    try {
      let batch: ObjectId[] = [];
      for await (const file of cursor) {
        batch.push(file._id);
        if (batch.length === MAINTENANCE_BATCH) {
          await this.deleteBatch(batch);
          await renew?.();
          count += batch.length;
          batch = [];
        }
      }
      await this.deleteBatch(batch);
      await renew?.();
      return count + batch.length;
    } finally {
      await cursor.close();
    }
  }

  private parseId(id: string): ObjectId | null {
    return /^[0-9a-f]{24}$/.test(id) ? new ObjectId(id) : null;
  }

  private toRecord(id: ObjectId, name: string, size: number, meta: UploadMetadata): UploadRecord {
    return defined({
      id: id.toHexString(),
      name,
      size,
      contentType: meta.contentType ?? null,
      ownerId: meta.ownerId,
      shareId: meta.shareId,
      expiresAt: meta.expiresAt,
    });
  }
}

class MongoLabStore implements LabStore {
  constructor(private readonly labs: Collection<LabDoc>) {}

  async create({ id, ...rest }: LabRecord) {
    await this.labs.insertOne({ _id: id, ...rest });
  }

  async get(id: string) {
    const doc = await this.labs.findOne({ _id: id });
    return doc ? fromLabDoc(doc) : null;
  }

  async update(id: string, patch: LabUpdate) {
    const set = defined(patch);
    if (Object.keys(set).length === 0) return this.get(id);
    const doc = await this.labs.findOneAndUpdate(
      { _id: id },
      { $set: set },
      { returnDocument: "after" },
    );
    return doc ? fromLabDoc(doc) : null;
  }

  async addStudent(id: string, student: LabStudent) {
    const doc = await this.labs.findOneAndUpdate(
      { _id: id },
      [
        {
          $set: {
            students: {
              $concatArrays: [
                {
                  $filter: {
                    input: "$students",
                    cond: { $ne: ["$$this.clientId", student.clientId] },
                  },
                },
                [{ $literal: student }],
              ],
            },
          },
        },
      ],
      { returnDocument: "after" },
    );
    return doc ? fromLabDoc(doc) : null;
  }

  async delete(id: string) {
    return (await this.labs.deleteOne({ _id: id })).deletedCount === 1;
  }

  async deleteExpired(now: Date) {
    return (await this.labs.deleteMany({ expiresAt: { $lt: now } })).deletedCount;
  }
}

const labelKey = (clientId: string, shareId: string) => `${clientId}:${shareId}`;

function fromLabelDoc({ _id: _, ...rest }: LabelDoc): ShareLabelRecord {
  return rest;
}

class MongoLabelStore implements LabelStore {
  constructor(private readonly labels: Collection<LabelDoc>) {}

  async get(clientId: string, shareId: string) {
    const doc = await this.labels.findOne({ _id: labelKey(clientId, shareId) });
    return doc ? fromLabelDoc(doc) : null;
  }

  async set(clientId: string, shareId: string, labels: ShareLabels, at: Date) {
    const entry: ShareLabelRecord = {
      clientId,
      shareId,
      folder: labels.folder,
      tags: [...labels.tags],
      updatedAt: at,
    };
    await this.labels.replaceOne({ _id: labelKey(clientId, shareId) }, entry, { upsert: true });
    return entry;
  }

  async delete(clientId: string, shareId: string) {
    return (await this.labels.deleteOne({ _id: labelKey(clientId, shareId) })).deletedCount === 1;
  }

  async listForClient(clientId: string) {
    return (await this.labels.find({ clientId }).toArray()).map(fromLabelDoc);
  }

  async deleteForShare(shareId: string) {
    return (await this.labels.deleteMany({ shareId })).deletedCount;
  }

  async shareIds() {
    return this.labels.distinct("shareId");
  }

  async clientIds() {
    return this.labels.distinct("clientId");
  }
}

class MongoSettingsStore implements SettingsStore {
  constructor(private readonly settings: Collection<SettingsDoc>) {}

  async get() {
    const doc = await this.settings.findOne({ _id: SETTINGS_DOC_ID }, { projection: { _id: 0 } });
    // Parsing fills defaults for fields added after the document was written.
    return doc ? settingsSchema.parse(doc) : defaultSettings();
  }

  async put(settings: Settings) {
    await this.settings.replaceOne({ _id: SETTINGS_DOC_ID }, { ...settings }, { upsert: true });
  }
}

class MongoAuditStore implements AuditStore {
  constructor(private readonly audit: Collection<AuditDoc>) {}

  async append(entry: AuditRecord) {
    await this.audit.insertOne(defined({ ...entry }));
  }

  async list({ limit, before }: AuditQuery) {
    const docs = await this.audit
      .find(before ? { at: { $lt: before } } : {}, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
    return docs as AuditRecord[];
  }

  async deleteOlderThan(before: Date) {
    return (await this.audit.deleteMany({ at: { $lt: before } })).deletedCount;
  }
}

class MongoDiagnosticsStore {
  constructor(private readonly db: Db) {}
  async replace(snapshot: DiagnosticSnapshot) {
    const clean = scrubDiagnosticSnapshot(snapshot);
    if (clean)
      await this.db
        .collection<DiagnosticSnapshot & { _id: string }>("diagnostics")
        .replaceOne({ _id: clean.slot }, clean, { upsert: true });
  }
  async list() {
    return this.db
      .collection<DiagnosticSnapshot>("diagnostics")
      .find({}, { projection: { _id: 0 } })
      .limit(16)
      .toArray();
  }
}
async function deleteBatches(
  collection: Collection,
  filter: Filter<Document>,
  renew: () => Promise<void>,
) {
  const cursor = collection.find(filter, { projection: { _id: 1 }, batchSize: MAINTENANCE_BATCH });
  const remove = async (ids: unknown[]) => {
    if (ids.length === 0) return;
    await collection.deleteMany({ ...filter, _id: { $in: ids } } as Filter<Document>);
    await renew();
  };
  try {
    let ids: unknown[] = [];
    for await (const doc of cursor) {
      ids.push(doc._id);
      if (ids.length === MAINTENANCE_BATCH) {
        await remove(ids);
        ids = [];
      }
    }
    await remove(ids);
  } finally {
    await cursor.close();
  }
}

class MongoMaintenance {
  constructor(
    private readonly db: Db,
    private readonly stores: Stores,
    private readonly files: MongoFileStore,
  ) {}

  async sweep(now: Date, renew: () => Promise<void>) {
    const settings = await this.stores.settings.get();
    await deleteBatches(
      this.db.collection(COLLECTIONS.shares),
      { expiresAt: { $ne: null, $lt: now } },
      renew,
    );
    await deleteBatches(this.db.collection(COLLECTIONS.labs), { expiresAt: { $lt: now } }, renew);
    let orphans = 0;
    for (const [collection, field] of [
      [COLLECTIONS.updates, "shareId"],
      [COLLECTIONS.snapshots, "shareId"],
      [`${UPLOADS_BUCKET}.files`, "metadata.shareId"],
      [COLLECTIONS.labels, "shareId"],
    ] as const) {
      const cursor = this.db
        .collection(collection)
        .aggregate<{ _id: string }>(
          [
            ...(field === "metadata.shareId" ? [{ $match: { [field]: { $exists: true } } }] : []),
            { $sort: { [field]: 1 } },
            { $group: { _id: `$${field}` } },
          ],
          { batchSize: MAINTENANCE_BATCH, allowDiskUse: true },
        );
      const clean = async (ids: string[]) => {
        if (ids.length === 0) return;
        const alive = await this.stores.shares.existing(ids);
        const missing = ids.filter((id) => !alive.has(id));
        if (missing.length > 0) {
          const filter = { shareId: { $in: missing } };
          await deleteBatches(this.db.collection(COLLECTIONS.updates), filter, renew);
          await deleteBatches(this.db.collection(COLLECTIONS.snapshots), filter, renew);
          await this.files.deleteForShares(missing, renew);
          await deleteBatches(this.db.collection(COLLECTIONS.labels), filter, renew);
          // Removing every reference means later sources cannot count this orphan twice.
          orphans += missing.length;
        }
        await renew();
      };
      try {
        let ids: string[] = [];
        for await (const row of cursor) {
          ids.push(row._id);
          if (ids.length === MAINTENANCE_BATCH) {
            await clean(ids);
            ids = [];
          }
        }
        await clean(ids);
      } finally {
        await cursor.close();
      }
    }
    await this.deleteInaccessible(renew);
    await deleteBatches(
      this.db.collection(COLLECTIONS.snapshots),
      {
        kind: "history",
        at: { $lt: new Date(now.getTime() - settings.historyRetentionDays * 86400000) },
      },
      renew,
    );
    await this.files.deleteExpired(now, renew);
    await deleteBatches(
      this.db.collection(COLLECTIONS.audit),
      {
        at: { $lt: new Date(now.getTime() - settings.audit.retentionDays * 86400000) },
      },
      renew,
    );
    return { orphans };
  }

  private async deleteInaccessible(renew: () => Promise<void>) {
    const labels = this.db.collection<LabelDoc>(COLLECTIONS.labels);
    let after: string | undefined;
    for (;;) {
      // Read labels before shares, matching the SQL and per-client fallback ordering.
      const entries = await labels
        .find(after === undefined ? {} : { _id: { $gt: after } })
        .sort({ _id: 1 })
        .limit(MAINTENANCE_BATCH)
        .toArray();
      if (entries.length === 0) break;
      after = entries.at(-1)?._id;
      const shares = await this.db
        .collection<ShareDoc>(COLLECTIONS.shares)
        .find(
          { _id: { $in: entries.map((entry) => entry.shareId) } },
          { projection: { _id: 1, ownerId: 1, savedBy: 1 } },
        )
        .toArray();
      const byId = new Map(shares.map((share) => [share._id, share]));
      const stale = entries.filter((entry) => {
        const share = byId.get(entry.shareId);
        return (
          !share || (share.ownerId !== entry.clientId && !share.savedBy.includes(entry.clientId))
        );
      });
      // Match the entire observed record so a concurrent replacement keeps its newer labels.
      if (stale.length > 0) await labels.deleteMany({ $or: stale });
      await renew();
    }
  }
}

export function createMongoStores(db: Db): Stores {
  const files = new MongoFileStore(db);
  const stores: Stores = {
    diagnostics: new MongoDiagnosticsStore(db),
    shares: new MongoShareStore(db.collection<ShareDoc>(COLLECTIONS.shares)),
    updates: new MongoUpdateLog(db.collection<UpdateDoc>(COLLECTIONS.updates)),
    snapshots: new MongoSnapshotStore(db.collection<SnapshotDoc>(COLLECTIONS.snapshots)),
    files,
    labs: new MongoLabStore(db.collection<LabDoc>(COLLECTIONS.labs)),
    labels: new MongoLabelStore(db.collection<LabelDoc>(COLLECTIONS.labels)),
    settings: new MongoSettingsStore(db.collection<SettingsDoc>(COLLECTIONS.settings)),
    audit: new MongoAuditStore(db.collection<AuditDoc>(COLLECTIONS.audit)),
  };
  stores.maintenance = new MongoMaintenance(db, stores, files);
  return registerTransferBackend(stores, createMongoTransferBackend(db));
}

/**
 * Creates every index of §5. Idempotent. Retention of history snapshots and audit entries
 * follows admin settings, so the sweeper prunes those instead of a fixed TTL.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(COLLECTIONS.shares).createIndexes([
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
      { key: { ownerId: 1 }, name: "ownerId" },
      { key: { createdAt: -1, _id: -1 }, name: "createdAt_id_desc" },
      { key: { savedBy: 1 }, name: "savedBy" },
      { key: { labId: 1 }, name: "labId", sparse: true },
    ]),
    db
      .collection(COLLECTIONS.updates)
      .createIndexes([{ key: { shareId: 1, seq: 1 }, name: "shareId_seq", unique: true }]),
    db.collection(COLLECTIONS.snapshots).createIndexes([
      { key: { shareId: 1, seq: 1 }, name: "shareId_seq" },
      { key: { shareId: 1, kind: 1, seq: 1 }, name: "shareId_kind_seq", unique: true },
      { key: { kind: 1, at: 1 }, name: "kind_at" },
    ]),
    db
      .collection(COLLECTIONS.labs)
      .createIndexes([{ key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 }]),
    db.collection(COLLECTIONS.labels).createIndexes([
      { key: { clientId: 1 }, name: "clientId" },
      { key: { shareId: 1 }, name: "shareId" },
    ]),
    db.collection(COLLECTIONS.audit).createIndexes([{ key: { at: -1 }, name: "at_desc" }]),
    db.collection(`${UPLOADS_BUCKET}.files`).createIndexes([
      { key: { filename: 1, uploadDate: 1 }, name: "filename_1_uploadDate_1" },
      { key: { "metadata.expiresAt": 1 }, name: "metadata_expiresAt" },
      { key: { "metadata.shareId": 1 }, name: "metadata_shareId", sparse: true },
    ]),
    db
      .collection(`${UPLOADS_BUCKET}.chunks`)
      .createIndexes([{ key: { files_id: 1, n: 1 }, name: "files_id_1_n_1", unique: true }]),
  ]);
}

export interface MongoConnection {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

/** Connects with the database named in the URL (default `gachipad`). */
export async function connectMongo(
  url: string,
  options: { dbName?: string; serverSelectionTimeoutMS?: number } = {},
): Promise<MongoConnection> {
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
  });
  await client.connect();
  const db = client.db(options.dbName);
  return { client, db, close: () => client.close() };
}
