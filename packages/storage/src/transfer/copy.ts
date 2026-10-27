import { createHash, type Hash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Document, MongoClient, MongoClientOptions } from "mongodb";
import type { OpenedStores } from "../open.js";
import { openStores, storageKindFromUrl } from "../open.js";
import { openSqlDriver, sqlErrorCode } from "../sql/driver.js";
import { transferBackend } from "./registry.js";
import { createSqlTransferBackend } from "./sql.js";
import {
  type AuditItem,
  type ShareMembers,
  TRANSFER_KINDS,
  type TransferBackend,
  type TransferCounts,
  type TransferKind,
  type TransferRecord,
  type TransferUpload,
} from "./types.js";

const BATCH_RECORDS = 64;
const BATCH_BYTES = 2 * 1024 * 1024;
const DIGEST_MODULUS = 1n << 256n;
/** Records expiring within this time after the start are skipped like expired ones. */
const EXPIRY_MARGIN_MS = 15 * 60_000;
/** Everything from the first count to the last verification read must finish within this time. */
const COPY_DEADLINE_MS = 10 * 60_000;
/** Largest accepted difference between this host's clock and a MongoDB server's clock. */
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const SAME_DATABASE = "Source and destination are the same";
const NOT_EMPTY = "Destination is not empty";
const NOT_PRIMARY = "MongoDB source is not the primary";
const CLOCK_SKEW = "MongoDB server clock differs from this host by more than 2 minutes";

export class CopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefusedError";
  }
}

export class CopyVerificationError extends Error {
  constructor(readonly counts: TransferCounts) {
    super("Copied data did not match the source");
    this.name = "CopyVerificationError";
  }
}

export class CopyFailureError extends Error {
  constructor(
    readonly counts: TransferCounts,
    readonly code?: string,
  ) {
    super("Database copy failed");
    this.name = "CopyFailureError";
  }
}

/** The copy outlasted COPY_DEADLINE_MS, so a TTL deletion may have gone unnoticed. */
export class CopyDeadlineError extends Error {
  constructor(readonly counts: TransferCounts) {
    super("Copy took longer than 10 minutes");
    this.name = "CopyDeadlineError";
  }
}

export interface CopyDatabaseOptions {
  /** Test seam; production callers use the configured storage opener. */
  openStores?: (url: string) => Promise<OpenedStores>;
  batchRecords?: number;
  batchBytes?: number;
}

export interface CopyDatabaseResult {
  counts: TransferCounts;
  digest: string;
}

function emptyCounts(): TransferCounts {
  return Object.fromEntries(TRANSFER_KINDS.map((kind) => [kind, 0])) as TransferCounts;
}

/**
 * Unambiguous text for a record. JSON values print as JSON; values JSON cannot hold (dates, bytes,
 * non-finite numbers, -0, undefined array items, BSON and other class instances) get distinct
 * `<...>` tags, so a lossy conversion on either side changes the digest. Audit details therefore
 * copy between different backends only when they are plain JSON, which every API caller writes.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0)
      ? JSON.stringify(value)
      : `<number:${Object.is(value, -0) ? "-0" : value}>`;
  if (value === undefined) return "<undefined>";
  if (typeof value === "bigint") return `<bigint:${value}>`;
  if (value instanceof Date) return `<date:${value.getTime()}>`;
  if (value instanceof Uint8Array)
    return `<bytes:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")}>`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null)
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    const type = "_bsontype" in value ? String(value._bsontype) : prototype?.constructor?.name;
    return `<${type ?? "object"}:${JSON.stringify(String(value))}>`;
  }
  return `<${typeof value}>`;
}

/**
 * JSON that every backend stores and returns unchanged: no undefined members or items, holes,
 * non-finite numbers, -0, or objects other than plain objects and arrays.
 */
function plainJson(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
    for (let index = 0; index < value.length; index++)
      if (!(index in value) || !plainJson(value[index])) return false;
    return true;
  }
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(plainJson)
  );
}

const supportedAudit = (item: AuditItem) =>
  item.record.detail === undefined || plainJson(item.record.detail);

/** Audit entries whose detail is not plain JSON; the copy refuses them before writing. */
async function unsupportedAudit(backend: TransferBackend): Promise<number> {
  let count = 0;
  for await (const item of backend.exportAudit()) if (!supportedAudit(item)) count++;
  return count;
}

function recordBytes(item: TransferRecord): Uint8Array | undefined {
  if (item.kind === "updates") return item.record.data;
  if (item.kind === "snapshots") return item.record.state;
  return undefined;
}

function withoutBytes(item: TransferRecord): unknown {
  if (item.kind === "updates") {
    const { data: _data, ...record } = item.record;
    return record;
  }
  if (item.kind === "snapshots") {
    const { state: _state, ...record } = item.record;
    return record;
  }
  if (item.kind === "audit") return { id: item.id, record: item.record };
  return item.record;
}

/** SHA-256 of one record's keyed canonical text; binary content is appended by the caller. */
function recordHash(kind: string, record: unknown, bytes = 0): Hash {
  return createHash("sha256").update(`${kind}\n${canonical(record)}\n${bytes}\n`);
}

/**
 * Order-independent digest: per kind, a count and the sum modulo 2^256 of every record's hash, so
 * backends may return records in any order. A share's savedBy and bans entries are hashed one by
 * one with their list index, whichever way the lists were paged.
 */
class TransferDigest {
  readonly counts = emptyCounts();
  uploadBytes = 0;
  private readonly sums = new Map<TransferKind, bigint>(TRANSFER_KINDS.map((kind) => [kind, 0n]));

  addRecord(item: TransferRecord): void {
    if (item.kind === "shareMembers") {
      this.addMembers(item.record);
      return;
    }
    this.counts[item.kind]++;
    if (item.kind === "shares") {
      const { savedBy, bans, ...share } = item.record;
      this.add("shares", recordHash("shares", share));
      this.addMembers({ shareId: share.id, list: "savedBy", offset: 0, clientIds: savedBy });
      this.addMembers({ shareId: share.id, list: "bans", offset: 0, clientIds: bans });
      return;
    }
    const data = recordBytes(item);
    const hash = recordHash(item.kind, withoutBytes(item), data?.byteLength);
    if (data) hash.update(data);
    this.add(item.kind, hash);
  }

  /** Counts and hashes the upload while its chunks pass through. */
  trackUpload(item: TransferUpload): AsyncIterable<Uint8Array> {
    this.counts.uploads++;
    const hash = recordHash(
      "uploads",
      { record: item.record, createdAt: item.createdAt },
      item.record.size,
    );
    const finish = () => {
      this.add("uploads", hash);
      this.uploadBytes += item.record.size;
    };
    const source = item.chunks;
    return (async function* () {
      let size = 0;
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > item.record.size) throw new Error("Upload content exceeded its stored size");
        hash.update(chunk);
        yield chunk;
      }
      if (size !== item.record.size)
        throw new Error("Upload content did not match its stored size");
      finish();
    })();
  }

  async addUpload(item: TransferUpload): Promise<void> {
    for await (const _chunk of this.trackUpload(item));
  }

  matches(other: TransferDigest): boolean {
    return (
      this.uploadBytes === other.uploadBytes &&
      TRANSFER_KINDS.every(
        (kind) =>
          this.counts[kind] === other.counts[kind] && this.sums.get(kind) === other.sums.get(kind),
      )
    );
  }

  digest(): string {
    const hash = createHash("sha256");
    for (const kind of TRANSFER_KINDS)
      hash.update(
        `${kind}:${this.counts[kind]}:${(this.sums.get(kind) ?? 0n).toString(16).padStart(64, "0")}\n`,
      );
    return hash.digest("hex");
  }

  private addMembers({ shareId, list, offset, clientIds }: ShareMembers): void {
    for (const [index, clientId] of clientIds.entries())
      this.add(
        "shares",
        recordHash("shareMembers", { shareId, list, index: offset + index, clientId }),
      );
  }

  private add(kind: TransferKind, hash: Hash): void {
    const value = BigInt(`0x${hash.digest("hex")}`);
    this.sums.set(kind, ((this.sums.get(kind) ?? 0n) + value) % DIGEST_MODULUS);
  }
}

function itemSize(item: TransferRecord): number {
  return Buffer.byteLength(canonical(withoutBytes(item))) + (recordBytes(item)?.byteLength ?? 0);
}

/** The SQLite driver's URL rules (sql/driver.ts). */
function sqlitePath(url: string): string {
  if (url === "sqlite::memory:" || url === "sqlite://:memory:") return ":memory:";
  if (url.startsWith("sqlite:") && !url.startsWith("sqlite://")) return url.slice("sqlite:".length);
  return decodeURIComponent(new URL(url).pathname);
}

/** The file behind a path, following symlinks of the file or, before it exists, its directory. */
async function fileIdentity(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    try {
      return join(await realpath(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/**
 * Where a SQL URL connects, with the defaults its driver applies; undefined when that cannot be
 * told (in-memory SQLite, or a URL the driver rejects later with its own safe error).
 */
async function sqlIdentity(
  kind: ReturnType<typeof storageKindFromUrl>,
  url: string,
): Promise<string | undefined> {
  try {
    if (kind === "sqlite") {
      // An in-memory or empty-path SQLite database is private to its connection.
      const path = sqlitePath(url);
      return path === ":memory:" || path === "" ? undefined : `sqlite:${await fileIdentity(path)}`;
    }
    const parsed = new URL(url);
    const hostname = decodeURIComponent(parsed.hostname.replace(/^\[(.+)\]$/, "$1"));
    // A repeated query parameter takes its last value in both drivers.
    const param = (name: string) => parsed.searchParams.getAll(name).at(-1);
    if (kind === "mysql") {
      // mysql2: host, port and database come from the URL only; a socketPath parameter (JSON or
      // plain text) replaces host and port.
      const database = decodeURIComponent(parsed.pathname.slice(1));
      const socket = param("socketPath");
      if (socket) {
        let socketPath: unknown = socket;
        try {
          socketPath = JSON.parse(socket);
        } catch {
          // mysql2 keeps the plain text.
        }
        if (socketPath) return `mysql:socket:${String(socketPath)}:${database}`;
      }
      const port = Number.parseInt(parsed.port, 10) || 3306;
      return `mysql:${(hostname || "localhost").toLowerCase()}:${port}:${database}`;
    }
    // pg: query parameters, then the URL, then PG* variables, then defaults. The database
    // defaults to the user name. A host starting with "/" is a socket directory: a
    // case-sensitive path, unlike a host name.
    const { env } = process;
    const host = param("host") || hostname || env.PGHOST || "localhost";
    const port = param("port") || parsed.port || env.PGPORT || "5432";
    const user = param("user") || decodeURIComponent(parsed.username) || env.PGUSER || env.USER;
    const path = parsed.pathname.slice(1);
    const database = (path ? decodeURI(path) : "") || env.PGDATABASE || user;
    const server = host.startsWith("/") ? host : host.toLowerCase();
    return `postgresql:${server}:${Number(port)}:${database ?? ""}`;
  } catch {
    return undefined;
  }
}

/** Before opening: equal strings, or SQL URLs that resolve to the same server and database. */
async function sameDatabase(
  fromKind: ReturnType<typeof storageKindFromUrl>,
  fromUrl: string,
  toKind: ReturnType<typeof storageKindFromUrl>,
  toUrl: string,
): Promise<boolean> {
  if (fromUrl === toUrl) return true;
  if (fromKind !== toKind || fromKind === "memory" || fromKind === "mongodb") return false;
  const [from, to] = await Promise.all([
    sqlIdentity(fromKind, fromUrl),
    sqlIdentity(toKind, toUrl),
  ]);
  return from !== undefined && from === to;
}

export interface MongoIdentity {
  database: string;
  /** topologyVersion.processId: one per running mongod or mongos. */
  processId?: string;
  setName?: string;
  /** Every member the replica set configuration advertises (hosts, passives, arbiters), plus
   * the primary and the answering member. */
  hosts: string[];
}

interface MongoServer {
  identity: MongoIdentity;
  /** The answering server is a writable primary. */
  primary: boolean;
  /** How far the server's clock lies outside this host's clock around the request, in ms. */
  skew: number;
}

/** One hello, sent with read preference primary like every copy read. */
async function mongoServer(client: MongoClient): Promise<MongoServer> {
  const before = Date.now();
  const hello: Document = await client
    .db("admin")
    .command({ hello: 1 }, { readPreference: "primary" });
  const after = Date.now();
  const processId = hello.topologyVersion?.processId;
  const serverTime = Number(hello.localTime);
  const members: unknown[] = [hello.hosts, hello.passives, hello.arbiters, hello.primary, hello.me]
    .flat()
    .filter((host) => typeof host === "string");
  return {
    identity: {
      database: client.db().databaseName,
      ...(processId ? { processId: String(processId) } : {}),
      ...(typeof hello.setName === "string" ? { setName: hello.setName } : {}),
      hosts: [...new Set(members.map((host) => String(host).toLowerCase()))],
    },
    primary: hello.isWritablePrimary === true,
    skew: !Number.isFinite(serverTime)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, before - serverTime, serverTime - after),
  };
}

/**
 * Same database on the same server or replica set, judged by the servers' own hello replies: the
 * same process, or the same replica set name with at least one advertised member in common. This
 * detects one mongod or mongos under different connection strings and one replica set reached
 * through different members or seed lists. It does not detect one sharded cluster behind
 * different mongos routers, nor members advertised under different names (split horizons); the
 * destination emptiness check still applies there. Distinct replica sets with the same name and
 * a shared member name are refused as the same.
 */
export function sameMongoDatabase(from: MongoIdentity, to: MongoIdentity): boolean {
  if (from.database !== to.database) return false;
  if (from.processId !== undefined && from.processId === to.processId) return true;
  return (
    from.setName !== undefined &&
    from.setName === to.setName &&
    from.hosts.some((host) => to.hosts.includes(host))
  );
}

/** The cutoff and the deadline assume this host's clock and the servers' TTL clocks agree. */
function refuseClockSkew(server: MongoServer): void {
  if (!(server.skew <= MAX_CLOCK_SKEW_MS)) throw new CopyRefusedError(CLOCK_SKEW);
}

/** Copy reads are only as complete as the server they reach: refuse anything but a primary. */
async function checkMongoSource(client: MongoClient): Promise<MongoServer> {
  let server: MongoServer;
  try {
    server = await mongoServer(client);
  } catch (error) {
    // Connected, but no primary could be selected for the hello.
    if (error instanceof Error && error.name === "MongoServerSelectionError")
      throw new CopyRefusedError(NOT_PRIMARY);
    throw error;
  }
  if (!server.primary) throw new CopyRefusedError(NOT_PRIMARY);
  refuseClockSkew(server);
  return server;
}

async function checkMongoDestination(client: MongoClient, source?: MongoServer): Promise<void> {
  const server = await mongoServer(client);
  if (source && sameMongoDatabase(source.identity, server.identity))
    throw new CopyRefusedError(SAME_DATABASE);
  refuseClockSkew(server);
}

/** The connection string goes to the driver unchanged; the copy adds only client options. */
async function connectMongoClient(url: string, options: MongoClientOptions): Promise<MongoClient> {
  const { MongoClient } = await import("mongodb");
  let client: MongoClient | undefined;
  try {
    client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000, ...options });
    await client.connect();
    return client;
  } catch {
    await client?.close().catch(() => undefined);
    throw new Error("MongoDB storage could not be opened");
  }
}

/** Opens the source; unlike the stores opener, it builds no indexes on a MongoDB source. */
async function openSource(
  url: string,
  kind: ReturnType<typeof storageKindFromUrl>,
): Promise<OpenedStores> {
  if (kind !== "mongodb") return openStores(url);
  const { createMongoStores } = await import("../mongo.js");
  const client = await connectMongoClient(url, {});
  return {
    stores: createMongoStores(client.db()),
    close: () => client.close(),
    kind: "mongodb",
    mongoClient: client,
  };
}

/** Opens the destination after the same-database and emptiness checks, before any write. */
async function openDestination(
  url: string,
  kind: ReturnType<typeof storageKindFromUrl>,
  source?: MongoServer,
): Promise<OpenedStores> {
  if (kind === "mongodb") {
    const [{ createMongoStores, ensureIndexes }, { createMongoTransferBackend }] =
      await Promise.all([import("../mongo.js"), import("./mongo.js")]);
    // No retried writes; majority writes, so the majority reads of verification see them.
    const client = await connectMongoClient(url, {
      retryWrites: false,
      writeConcern: { w: "majority" },
    });
    try {
      await checkMongoDestination(client, source);
      const db = client.db();
      if (!(await createMongoTransferBackend(db).isEmpty())) throw new CopyRefusedError(NOT_EMPTY);
      await ensureIndexes(db);
      return {
        stores: createMongoStores(db),
        close: () => client.close(),
        kind: "mongodb",
        mongoClient: client,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
  if (kind !== "memory") {
    const driver = await openSqlDriver(url);
    try {
      if (!(await createSqlTransferBackend(driver).isEmpty()))
        throw new CopyRefusedError(NOT_EMPTY);
    } finally {
      await driver.close();
    }
  }
  return openStores(url);
}

async function readAll(
  backend: TransferBackend,
  cutoff: Date,
  inTime: () => void,
): Promise<TransferDigest> {
  const digest = new TransferDigest();
  for await (const item of backend.exportAll(cutoff)) {
    inTime();
    if (item.kind === "uploads") await digest.addUpload(item);
    else digest.addRecord(item);
  }
  return digest;
}

async function copyRecords(
  source: TransferBackend,
  destination: TransferBackend,
  digest: TransferDigest,
  cutoff: Date,
  batchRecords: number,
  batchBytes: number,
  inTime: () => void,
): Promise<void> {
  let batch: TransferRecord[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await destination.importBatch(batch);
    batch = [];
    size = 0;
  };

  for await (const item of source.exportAll(cutoff)) {
    inTime();
    if (item.kind === "uploads") {
      await flush();
      await destination.importUpload(item.record, item.createdAt, digest.trackUpload(item));
      continue;
    }

    // Checked before the import too: a detail written after the check could be stored lossily.
    if (item.kind === "audit" && !supportedAudit(item))
      throw new CopyVerificationError({ ...digest.counts });
    digest.addRecord(item);
    const itemBytes = itemSize(item);
    if (batch.length && (batch.length >= batchRecords || size + itemBytes > batchBytes))
      await flush();
    batch.push(item);
    size += itemBytes;
    if (batch.length >= batchRecords || size >= batchBytes) await flush();
  }
  await flush();
}

export async function copyDatabase(
  fromUrl: string,
  toUrl: string,
  options: CopyDatabaseOptions = {},
): Promise<CopyDatabaseResult> {
  let fromKind: ReturnType<typeof storageKindFromUrl>;
  let toKind: ReturnType<typeof storageKindFromUrl>;
  try {
    fromKind = storageKindFromUrl(fromUrl);
    toKind = storageKindFromUrl(toUrl);
  } catch {
    throw new CopyRefusedError("Unsupported database URL scheme");
  }

  const open = options.openStores;
  let source: OpenedStores | undefined;
  let destination: OpenedStores | undefined;
  let copiedCounts = emptyCounts();
  try {
    if (await sameDatabase(fromKind, fromUrl, toKind, toUrl))
      throw new CopyRefusedError(SAME_DATABASE);
    source = open ? await open(fromUrl) : await openSource(fromUrl, fromKind);
    const sourceServer = source.mongoClient && (await checkMongoSource(source.mongoClient));
    const sourceTransfer = transferBackend(source.stores);
    const unsupported = await unsupportedAudit(sourceTransfer);
    if (unsupported)
      throw new CopyRefusedError(
        `Audit details are not plain JSON in ${unsupported} ${unsupported === 1 ? "record" : "records"}`,
      );
    if (open) {
      destination = await open(toUrl);
      if (destination.mongoClient)
        await checkMongoDestination(destination.mongoClient, sourceServer);
    } else destination = await openDestination(toUrl, toKind, sourceServer);
    const destinationTransfer = transferBackend(destination.stores);
    if (!(await destinationTransfer.isEmpty())) throw new CopyRefusedError(NOT_EMPTY);

    // One fixed cutoff for every read below. Records expiring at or before it are skipped like
    // expired ones, and the run must end well before it (allowing for clock skew), so no record
    // the reads include can reach its expiry, and a TTL deletion, while they run. Elapsed time
    // comes from the monotonic clock, which wall-clock changes do not move.
    const started = performance.now();
    const cutoff = new Date(Date.now() + EXPIRY_MARGIN_MS);
    const inTime = () => {
      if (performance.now() - started >= COPY_DEADLINE_MS)
        throw new CopyDeadlineError({ ...copiedCounts });
    };
    const live = await sourceTransfer.countLive(cutoff);
    const copied = new TransferDigest();
    copiedCounts = copied.counts;
    await copyRecords(
      sourceTransfer,
      destinationTransfer,
      copied,
      cutoff,
      Math.max(1, options.batchRecords ?? BATCH_RECORDS),
      Math.max(1024, options.batchBytes ?? BATCH_BYTES),
      inTime,
    );
    await destinationTransfer.recomputeCounters();

    // Verification does not trust the copy stream: it reads the source a second time and the
    // destination, then compares both with each other and with what was copied. A record that
    // changed meanwhile makes them differ, so the copy fails instead of losing it.
    const reread = await readAll(sourceTransfer, cutoff, inTime);
    const stored = await readAll(destinationTransfer, cutoff, inTime);
    const counter = await destinationTransfer.uploadCounter();
    // After the last read: matching reads prove nothing once a TTL deletion could have run.
    inTime();
    if (
      !copied.matches(reread) ||
      !reread.matches(stored) ||
      live.shares !== reread.counts.shares ||
      live.labs !== reread.counts.labs ||
      (counter !== undefined && counter !== stored.uploadBytes)
    )
      throw new CopyVerificationError({ ...copied.counts });
    return { counts: copied.counts, digest: stored.digest() };
  } catch (error) {
    if (error instanceof CopyRefusedError || error instanceof CopyVerificationError) throw error;
    if (error instanceof CopyFailureError || error instanceof CopyDeadlineError) throw error;
    const code = safeDriverCode(error);
    throw new CopyFailureError({ ...copiedCounts }, code);
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

function safeDriverCode(error: unknown, seen = new Set<object>()): string | undefined {
  const sqlCode = sqlErrorCode(error);
  if (sqlCode) return sqlCode;
  if (error instanceof Error) {
    const match =
      /^(?:sqlite|postgresql|mysql) storage (?:connection|migration) failed(?: \(([A-Z0-9_]{1,64})\))?$/.exec(
        error.message,
      );
    if (match) return match[1];
  }
  if (typeof error !== "object" || error === null || seen.has(error)) return undefined;
  seen.add(error);
  const details = error as Record<string, unknown>;
  const code = details.code;
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 99999)
    return `MONGO_${code}`;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  for (const key of ["originalError", "cause", "errorResponse"])
    if (key in details) {
      const nested = safeDriverCode(details[key], seen);
      if (nested) return nested;
    }
  return undefined;
}

export function countsForCli(counts?: TransferCounts): TransferCounts {
  return counts ? { ...counts } : emptyCounts();
}
