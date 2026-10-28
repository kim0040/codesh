/** Run on the dev box: pnpm --filter @gachipad/collab exec tsx ../../packages/storage/bench-mongo.ts before
 * MONGO_BENCH_IMPL can select a baseline module saved beside src/mongo.ts.
 * Uses only codesh_bench_mongo and always drops it. Serialize runs with flock /tmp/codesh-bench-mongo.lock.
 */
import { performance } from "node:perf_hooks";
import { Binary, BSON, type Filter, MongoClient, ObjectId, type Sort } from "mongodb";
import type { ValkeyLock } from "../../apps/collab/src/lock.js";
import { sweep } from "../../apps/collab/src/sweeper.js";

const { connectMongo, createMongoStores, ensureIndexes }: typeof import("./src/mongo.js") =
  await import(process.env.MONGO_BENCH_IMPL ?? "./src/mongo.js");

const label = process.argv[2] ?? "measurement";
const connection = await connectMongo("mongodb://127.0.0.1:27017/codesh_bench_mongo");
const clientOptions = connection.client.options;
await connection.close();
// Enable command monitoring before the pool opens; toggling it does not affect existing sockets.
const client = new MongoClient("mongodb://127.0.0.1:27017/codesh_bench_mongo", {
  monitorCommands: true,
  serverSelectionTimeoutMS: clientOptions.serverSelectionTimeoutMS,
});
await client.connect();
const db = client.db();
const stores = createMongoStores(db);
const now = new Date();
const future = new Date(now.getTime() + 86400_000);
const bytes = new Uint8Array(1024).fill(7);
const id = (i: number) => `bench${String(i).padStart(6, "0")}`;
const owner = (i: number) => `client${i % 2000}`;
const lock = {
  acquire: async () => true,
  renew: async () => true,
  release: async () => true,
} as unknown as ValkeyLock;
const results: Record<string, unknown> = {};
async function time(name: string, fn: (i: number) => Promise<unknown>, count = 40) {
  for (let i = 0; i < 5; i++) await fn(i);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await fn(i);
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  results[name] = {
    n: count,
    p50: Number(values[Math.floor(count * 0.5)]?.toFixed(3)),
    p95: Number(values[Math.min(count - 1, Math.floor(count * 0.95))]?.toFixed(3)),
  };
}
async function seedUploads(count: number, expired = false) {
  const files = Array.from({ length: count }, (_, i) => ({
    _id: new ObjectId(),
    length: 1024,
    chunkSize: 261120,
    uploadDate: now,
    filename: "bench.bin",
    metadata: {
      ownerId: owner(i),
      shareId: id(i),
      expiresAt: expired ? now : future,
      contentType: null,
    },
  }));
  await db.collection("uploads.files").insertMany(files);
  await db
    .collection("uploads.chunks")
    .insertMany(files.map((f) => ({ files_id: f._id, n: 0, data: new Binary(bytes) })));
  // Raw fixtures must keep an already-initialized quota ledger consistent.
  await db
    .collection<{ _id: string; bytes: number }>("storage_quotas")
    .updateOne({ _id: "uploads" }, { $inc: { bytes: count * 1024 } });
  return files;
}
try {
  await db.dropDatabase();
  await ensureIndexes(db);
  for (let offset = 0; offset < 20000; offset += 1000) {
    const shares = Array.from({ length: 1000 }, (_, j) => {
      const i = offset + j;
      return {
        _id: id(i),
        title: `Share ${i}`,
        language: "typescript",
        ownerId: owner(i),
        createdAt: new Date(now.getTime() - i * 30000),
        updatedAt: new Date(now.getTime() - i * 1000),
        lastActiveAt: now,
        expiresAt: future,
        saved: false,
        savedBy: [owner(i + 1)],
        access: {
          default: "edit",
          editKey: "synthetic",
          pinHash: null,
          requireApproval: false,
          nearby: true,
        },
        bans: [],
        joinCode: "123456",
        locked: false,
        sizeBytes: 1024,
        preview: "x".repeat(500),
      };
    });
    await db.collection<{ _id: string }>("shares").insertMany(shares);
    await db.collection<{ _id: string }>("share_labels").insertMany(
      shares.map((s) => ({
        _id: `${s.ownerId}:${s._id}`,
        clientId: s.ownerId,
        shareId: s._id,
        folder: "Week 1",
        tags: ["loops"],
        updatedAt: now,
      })),
    );
    await db.collection("share_updates").insertMany(
      shares.flatMap((s) =>
        Array.from({ length: 10 }, (_, n) => ({
          shareId: s._id,
          seq: n + 1,
          at: now,
          data: new Binary(bytes),
        })),
      ),
    );
    await db.collection("share_snapshots").insertMany(
      shares.map((s) => ({
        shareId: s._id,
        seq: 10,
        kind: "compact",
        at: now,
        state: new Binary(bytes),
      })),
    );
  }
  const uploads = await seedUploads(2000);
  const fixture = { name: "bench.bin", ownerId: owner(0), contentType: null, expiresAt: future };
  const fileId = uploads[0]?._id.toHexString() ?? "";
  const plans: Record<string, unknown> = {};
  const queries: Array<[string, string, Filter<{ _id: string | ObjectId }>, Sort, number]> = [
    ["get", "shares", { _id: id(0) }, {}, 1],
    [
      "listForClient",
      "shares",
      { $or: [{ ownerId: owner(0) }, { savedBy: owner(0) }] },
      { updatedAt: -1, _id: 1 },
      0,
    ],
    [
      "adminList",
      "shares",
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      { createdAt: -1, _id: -1 },
      100,
    ],
    ["updates.read", "share_updates", { shareId: id(0), seq: { $gt: 5 } }, { seq: 1 }, 0],
    ["snapshots.latest", "share_snapshots", { shareId: id(0), kind: "compact" }, { seq: -1 }, 1],
    ["labels.list", "share_labels", { clientId: owner(0) }, {}, 0],
  ];
  for (const [name, collection, filter, sort, limit] of queries) {
    const explain = await db
      .collection<{ _id: string | ObjectId }>(collection)
      .find(filter)
      .sort(sort)
      .limit(limit)
      .explain("executionStats");
    plans[name] = {
      plan: explain.queryPlanner.winningPlan,
      returned: explain.executionStats.nReturned,
      keys: explain.executionStats.totalKeysExamined,
      docs: explain.executionStats.totalDocsExamined,
    };
  }
  await time("touch", (i) => stores.shares.touch(id(i), now, future));
  await time("shares.get", (i) => stores.shares.get(id(i)));
  await time("updates.append10", (i) =>
    stores.updates
      .append(
        `append${i}`,
        Array.from({ length: 10 }, (_, n) => ({ seq: n + 1, data: bytes })),
        now,
      )
      .then(() => stores.updates.deleteForShare(`append${i}`)),
  );
  await time("updates.read5", (i) => stores.updates.read(id(i), 5));
  await time("snapshots.latest", (i) => stores.snapshots.latest(id(i), "compact"));
  await time("snapshots.put", (i) =>
    stores.snapshots.put({ shareId: id(i), seq: 10, kind: "compact", at: now, state: bytes }),
  );
  await time("shares.listForClient", (i) => stores.shares.listForClient(owner(i)));
  await time("labels.listForClient", (i) => stores.labels.listForClient(owner(i)));
  await time("adminList", () => stores.shares.adminList(""));
  await time("adminList.search", () => stores.shares.adminList("Share 99"));
  await time("adminSummary", () => stores.shares.adminSummary());
  await time("files.get", () => stores.files.get(fileId));
  await time("files.openDownload", async () => {
    const opened = await stores.files.openDownload(fileId);
    for await (const _chunk of opened?.stream ?? []) {
      /* consume */
    }
  });
  await time(
    "files.put64chunks",
    async () => {
      const meta = await stores.files.putStream(
        {
          ...fixture,
          stream: (async function* () {
            for (let i = 0; i < 64; i++) yield bytes;
          })(),
        },
        undefined,
        100000000,
      );
      await stores.files.delete(meta.id);
    },
    20,
  );
  await time("files.shareIds", () => stores.files.shareIds());
  await time("sweep.live20k", () => sweep(stores, lock, now), 5);
  await time(
    "sweep.orphans300",
    async () => {
      const ids = Array.from({ length: 300 }, (_, i) => `orphan${i}`);
      await db
        .collection("share_updates")
        .insertMany(ids.map((shareId) => ({ shareId, seq: 1, data: new Binary(bytes), at: now })));
      await db.collection("share_snapshots").insertMany(
        ids.map((shareId) => ({
          shareId,
          seq: 1,
          kind: "compact",
          state: new Binary(bytes),
          at: now,
        })),
      );
      await db.collection<{ _id: string }>("share_labels").insertMany(
        ids.map((shareId) => ({
          _id: `orphan:${shareId}`,
          clientId: "orphan",
          shareId,
          folder: null,
          tags: [],
          updatedAt: now,
        })),
      );
      return sweep(stores, lock, now);
    },
    5,
  );
  await time(
    "files.deleteExpired100",
    async () => {
      await seedUploads(100, true);
      return stores.files.deleteExpired(new Date(now.getTime() + 1));
    },
    5,
  );
  const diagnostics: Record<string, unknown> = {};
  async function trace(name: string, fn: () => Promise<unknown>) {
    let count = 0;
    let replyBytes = 0;
    const started = () => {
      count++;
    };
    const succeeded = (event: { reply: object }) => {
      replyBytes += BSON.calculateObjectSize(event.reply);
    };
    client.on("commandStarted", started);
    client.on("commandSucceeded", succeeded);
    try {
      await fn();
    } finally {
      client.off("commandStarted", started);
      client.off("commandSucceeded", succeeded);
    }
    if (count === 0) throw new Error("command monitoring did not observe the operation");
    diagnostics[name] = { commands: count, replyBytes };
  }
  await trace("updates.read5", () => stores.updates.read(id(0), 5));
  await trace("files.put64chunks", async () => {
    const meta = await stores.files.putStream(
      {
        ...fixture,
        stream: (async function* () {
          for (let i = 0; i < 64; i++) yield bytes;
        })(),
      },
      undefined,
      100000000,
    );
    await stores.files.delete(meta.id);
  });
  await trace("files.shareIds", () => stores.files.shareIds());
  await trace("sweep.live20k", () => sweep(stores, lock, now));
  await seedUploads(100, true);
  await trace("files.deleteExpired100", () =>
    stores.files.deleteExpired(new Date(now.getTime() + 1)),
  );
  plans["maintenance.updates"] = await db
    .collection("share_updates")
    .aggregate([{ $sort: { shareId: 1 } }, { $group: { _id: "$shareId" } }])
    .explain("executionStats");
  const indexUsage = await db
    .collection("shares")
    .aggregate([{ $indexStats: {} }])
    .toArray();
  const hello = await db.admin().command({ hello: 1 });
  console.log(
    JSON.stringify(
      {
        label,
        server: (await db.admin().serverInfo()).version,
        replicaSet: hello.setName ?? null,
        dataset: {
          shares: 20000,
          updates: 200000,
          clients: 2000,
          labels: 20000,
          snapshots: 20000,
          uploads: 2000,
        },
        client: {
          maxPoolSize: client.options.maxPoolSize,
          minPoolSize: client.options.minPoolSize,
          retryReads: client.options.retryReads,
          retryWrites: client.options.retryWrites,
          writeConcern: client.options.writeConcern,
          readConcern: client.options.readConcern,
          compressors: client.options.compressors,
          maxConnecting: client.options.maxConnecting,
          connectTimeoutMS: client.options.connectTimeoutMS,
          socketTimeoutMS: client.options.socketTimeoutMS,
          waitQueueTimeoutMS: client.options.waitQueueTimeoutMS,
          serverSelectionTimeoutMS: client.options.serverSelectionTimeoutMS,
          readPreference: client.options.readPreference,
        },
        results,
        diagnostics,
        indexUsage,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  await db.dropDatabase();
  await client.close();
}
