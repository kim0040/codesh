import {
  type AuditRecord,
  defaultSettings,
  type LabRecord,
  type LabStudent,
  SETTINGS_DOC_ID,
  type Settings,
  type ShareRecord,
  type SnapshotKind,
  type SnapshotRecord,
  settingsSchema,
  type UploadRecord,
} from "@codesh/shared";
import {
  Binary,
  type Collection,
  type Db,
  GridFSBucket,
  MongoBulkWriteError,
  MongoClient,
  ObjectId,
} from "mongodb";
import {
  type AuditQuery,
  type AuditStore,
  DuplicateSeqError,
  type FileStore,
  type LabStore,
  type LabUpdate,
  type NewUpload,
  type SettingsStore,
  type ShareStore,
  type ShareUpdate,
  type SnapshotStore,
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
  settings: "settings",
  audit: "audit",
} as const;

export const UPLOADS_BUCKET = "uploads";

const DUPLICATE_KEY = 11000;

type ShareDoc = Omit<ShareRecord, "id"> & { _id: string };
type LabDoc = Omit<LabRecord, "id"> & { _id: string };
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
  constructor(private readonly shares: Collection<ShareDoc>) {}

  async create({ id, ...rest }: ShareRecord) {
    await this.shares.insertOne(defined({ _id: id, ...rest }));
  }

  async get(id: string) {
    const doc = await this.shares.findOne({ _id: id });
    return doc ? fromShareDoc(doc) : null;
  }

  async update(id: string, patch: ShareUpdate) {
    const set = defined(patch);
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
      .find({ shareId, seq: { $gt: afterSeq } })
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

  constructor(db: Db) {
    this.bucket = new GridFSBucket(db, { bucketName: UPLOADS_BUCKET });
  }

  async put(upload: NewUpload) {
    const { data, name, ...rest } = upload;
    const metadata: UploadMetadata = defined({
      ownerId: rest.ownerId,
      shareId: rest.shareId,
      expiresAt: rest.expiresAt,
      contentType: rest.contentType,
    });
    const stream = this.bucket.openUploadStream(name, { metadata });
    await new Promise<void>((resolve, reject) => {
      stream.once("finish", () => resolve());
      stream.once("error", reject);
      stream.end(data);
    });
    return this.toRecord(stream.id as ObjectId, name, data.byteLength, metadata);
  }

  async get(id: string) {
    const _id = this.parseId(id);
    if (!_id) return null;
    const file = await this.bucket.find({ _id }).next();
    if (!file) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.bucket.openDownloadStream(_id)) chunks.push(chunk as Uint8Array);
    const data = new Uint8Array(file.length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      meta: this.toRecord(_id, file.filename, file.length, file.metadata as UploadMetadata),
      data,
    };
  }

  async delete(id: string) {
    const _id = this.parseId(id);
    if (!_id || !(await this.bucket.find({ _id }).hasNext())) return false;
    await this.bucket.delete(_id);
    return true;
  }

  async deleteForShare(shareId: string) {
    return this.deleteWhere({ "metadata.shareId": shareId });
  }

  async deleteExpired(now: Date) {
    return this.deleteWhere({ "metadata.expiresAt": { $lt: now } });
  }

  async shareIds() {
    const ids = await this.bucket.find({ "metadata.shareId": { $exists: true } }).toArray();
    return [...new Set(ids.map((f) => (f.metadata as UploadMetadata).shareId as string))];
  }

  private async deleteWhere(filter: Record<string, unknown>) {
    const files = await this.bucket.find(filter, { projection: { _id: 1 } }).toArray();
    for (const file of files) await this.bucket.delete(file._id);
    return files.length;
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

export function createMongoStores(db: Db): Stores {
  return {
    shares: new MongoShareStore(db.collection<ShareDoc>(COLLECTIONS.shares)),
    updates: new MongoUpdateLog(db.collection<UpdateDoc>(COLLECTIONS.updates)),
    snapshots: new MongoSnapshotStore(db.collection<SnapshotDoc>(COLLECTIONS.snapshots)),
    files: new MongoFileStore(db),
    labs: new MongoLabStore(db.collection<LabDoc>(COLLECTIONS.labs)),
    settings: new MongoSettingsStore(db.collection<SettingsDoc>(COLLECTIONS.settings)),
    audit: new MongoAuditStore(db.collection<AuditDoc>(COLLECTIONS.audit)),
  };
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

/** Connects with the database named in the URL (default `codesh`). */
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
