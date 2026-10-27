import { createHash, type Hash } from "node:crypto";
import { access, open as openFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Document, MongoClient, MongoClientOptions } from "mongodb";
import type { OpenedStores } from "../open.js";
import { openStores, storageKindFromUrl } from "../open.js";
import { openSqlDriver, sqlErrorCode } from "../sql/driver.js";
import { createSqlStores } from "../sql/stores.js";
import { transferBackend } from "./registry.js";
import { createSqlTransferBackend, supportedSqlSchema } from "./sql.js";
import { OPERATION_TIMEOUT_MS, withTimeout } from "./timeout.js";
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
/**
 * The copy window in minutes. Records expiring within the window after the start are skipped like
 * expired ones, and everything from the first count to the last verification read must finish
 * within the window minus DEADLINE_RESERVE_MS.
 */
export const COPY_WINDOW_MINUTES = { default: 15, min: 15, max: 1440 } as const;
/** Larger than MAX_CLOCK_SKEW_MS, so deadline + skew stays below the expiry margin. */
const DEADLINE_RESERVE_MS = 5 * 60_000;
/** Largest accepted difference between this host's clock and a MongoDB server's clock. */
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** Waits before each repeated check of a source whose newest writes are not majority-committed. */
const MAJORITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
/** How long a majority write may wait for replication before it fails. */
const WRITE_CONCERN_TIMEOUT_MS = 60_000;
/** How long closing a connection may take after the copy ended or a check failed. */
export const CLOSE_TIMEOUT_MS = 10_000;
/** pg drops a query stuck this long with its connection, after the copy's own timeout reported it. */
export const PG_QUERY_TIMEOUT_MS = OPERATION_TIMEOUT_MS + 5_000;
const SAME_DATABASE = "Source and destination are the same";
const NOT_EMPTY = "Destination is not empty";
const NOT_PRIMARY = "MongoDB source is not the primary";
const NOT_MAJORITY = "MongoDB source has writes not yet replicated to a majority";
const CLOCK_SKEW = "MongoDB server clock differs from this host by more than 2 minutes";
const NOT_PERSISTENT = "Source and destination must be persistent databases";
const SQLITE_URI = "SQLite databases must be plain file paths, not file: URIs";
const SQLITE_IN_USE =
  "SQLite source is open elsewhere or was not closed cleanly: it has -wal or -shm files";
const SQL_SCHEMA = "SQL source schema version is missing or not supported";
const WINDOW_RANGE = `Copy window must be a whole number of minutes from ${COPY_WINDOW_MINUTES.min} to ${COPY_WINDOW_MINUTES.max}`;

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
    /** false when the run failed before its first write to the destination. */
    readonly destinationWritten = true,
  ) {
    super("Database copy failed");
    this.name = "CopyFailureError";
  }
}

/** The copy outlasted its deadline, so a TTL deletion may have gone unnoticed. */
export class CopyDeadlineError extends Error {
  constructor(
    readonly counts: TransferCounts,
    readonly minutes: number,
  ) {
    super(`Copy took longer than ${minutes} minutes`);
    this.name = "CopyDeadlineError";
  }
}

export interface CopyDatabaseOptions {
  /** Test seam; production callers use the configured storage opener. */
  openStores?: (url: string) => Promise<OpenedStores>;
  /** The copy window in minutes, COPY_WINDOW_MINUTES.default when omitted. */
  windowMinutes?: number;
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

/**
 * SQLite reads a name starting with file: as a URI, whose escaped options can make the database
 * in-memory or temporary. Spelled in any case, such names are refused rather than decoded.
 */
function sqliteUri(kind: ReturnType<typeof storageKindFromUrl>, url: string): boolean {
  if (kind !== "sqlite") return false;
  try {
    return /^file:/i.test(sqlitePath(url));
  } catch {
    // The driver rejects this URL with its own error.
    return false;
  }
}

/** In-memory and temporary SQLite databases end with their connection. */
function persistentDatabase(kind: ReturnType<typeof storageKindFromUrl>, url: string): boolean {
  if (kind === "memory") return false;
  if (kind !== "sqlite") return true;
  try {
    const path = sqlitePath(url);
    return path !== "" && path !== ":memory:";
  } catch {
    // The driver rejects this URL with its own error.
    return true;
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Whether a SQLite file has -wal or -shm files, which SQLite keeps next to the file a link names. */
async function sqliteSidecars(path: string): Promise<boolean> {
  for (const file of new Set([path, await realpath(path)]))
    if ((await exists(`${file}-wal`)) || (await exists(`${file}-shm`))) return true;
  return false;
}

/**
 * How a SQLite source opens without writing to it. A rollback-journal file opens read-only. A
 * WAL-mode file is read as immutable, since read-only access would create or write its -wal and
 * -shm files; those exist only while it is open or after it was not closed cleanly, and then the
 * source is refused.
 */
async function sqliteSourceMode(path: string): Promise<true | "immutable"> {
  // Opening a missing file would create it.
  if (!(await exists(path))) throw new CopyRefusedError(SQL_SCHEMA);
  const header = Buffer.alloc(20);
  const file = await openFile(path, "r");
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  // Bytes 18 and 19 of a database header are 2 in WAL mode (sqlite.org/fileformat.html).
  if (header.toString("latin1", 0, 16) !== "SQLite format 3\0") return true;
  if (header[18] !== 2 && header[19] !== 2) return true;
  if (await sqliteSidecars(path)) throw new CopyRefusedError(SQLITE_IN_USE);
  return "immutable";
}

/** The URL the copy connects with: a PostgreSQL URL gains pg's query_timeout unless it sets one. */
function connectionUrl(kind: ReturnType<typeof storageKindFromUrl>, url: string): string {
  if (kind !== "postgresql" || url.includes("#")) return url;
  try {
    if (new URL(url).searchParams.has("query_timeout")) return url;
  } catch {
    // The driver rejects this URL with its own error.
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}query_timeout=${PG_QUERY_TIMEOUT_MS}`;
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
    if (kind === "mysql") {
      // mysql2 3.24.6 (ConnectionConfig.parseUrl): host, port and database come from the URL, and
      // query parameters of those names are ignored. Any other parameter takes its first value, as
      // JSON when it parses; a socketPath that is set replaces host and port.
      const database = decodeURIComponent(parsed.pathname.slice(1));
      const socket = parsed.searchParams.get("socketPath");
      let socketPath: unknown;
      if (socket !== null)
        try {
          socketPath = JSON.parse(socket);
        } catch {
          socketPath = socket;
        }
      if (socketPath) return `mysql:socket:${String(socketPath)}:${database}`;
      const port = Number.parseInt(parsed.port, 10) || 3306;
      return `mysql:${(hostname || "localhost").toLowerCase()}:${port}:${database}`;
    }
    // A repeated query parameter takes its last value in pg.
    const param = (name: string) => parsed.searchParams.getAll(name).at(-1);
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
  /** A replica set member whose newest write is not majority-committed, or that does not say. */
  behindMajority: boolean;
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
  const { opTime, majorityOpTime } = hello.lastWrite ?? {};
  return {
    identity: {
      database: client.db().databaseName,
      ...(processId ? { processId: String(processId) } : {}),
      ...(typeof hello.setName === "string" ? { setName: hello.setName } : {}),
      hosts: [...new Set(members.map((host) => String(host).toLowerCase()))],
    },
    primary: hello.isWritablePrimary === true,
    // Standalone servers and mongos routers carry no setName; their reads see every write.
    behindMajority:
      typeof hello.setName === "string" &&
      !(opTime && majorityOpTime && canonical(opTime) === canonical(majorityOpTime)),
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

/**
 * Copy reads are only as complete as the server they reach: refuse anything but a primary, and a
 * primary whose newest writes are not majority-committed yet, which majority reads cannot see.
 * Writers are stopped, so a lag that lasts through the repeated checks is a degraded set.
 */
async function checkMongoSource(client: MongoClient): Promise<MongoServer> {
  for (const delay of [...MAJORITY_RETRY_DELAYS_MS, undefined]) {
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
    if (!server.behindMajority) {
      refuseClockSkew(server);
      return server;
    }
    if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new CopyRefusedError(NOT_MAJORITY);
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
    // A server that stops answering fails the operation instead of stalling the copy.
    client = new MongoClient(url, {
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: OPERATION_TIMEOUT_MS,
      ...options,
    });
    await client.connect();
    return client;
  } catch {
    await closeWithin(client);
    throw new Error("MongoDB storage could not be opened");
  }
}

/**
 * Settles within CLOSE_TIMEOUT_MS: a connection stuck in a timed-out operation must not hold the
 * copy, and pg's own close waits for it.
 */
function closeWithin(connection?: { close(): Promise<void> }): Promise<void> {
  return withTimeout(connection?.close() ?? Promise.resolve(), CLOSE_TIMEOUT_MS).catch(
    () => undefined,
  );
}

/** Waits for stores to open within the operation timeout; stores that open later are closed. */
async function openWithin(opening: Promise<OpenedStores>): Promise<OpenedStores> {
  try {
    return await withTimeout(opening);
  } catch (error) {
    void opening.then(closeWithin, () => undefined);
    throw error;
  }
}

interface OpenedSource extends OpenedStores {
  /** false when something else may have opened the source while the copy read it. */
  untouched?: () => Promise<boolean>;
}

/**
 * Opens the source as it is: unlike the stores opener, it builds no indexes on a MongoDB source
 * and runs no migration on a SQL source, which must have exactly the schema this code knows. A
 * SQLite source is opened read-only. Its schema check and, when that fails, its close are bounded.
 */
async function openSource(
  url: string,
  kind: ReturnType<typeof storageKindFromUrl>,
): Promise<OpenedSource> {
  if (kind !== "mongodb") {
    const path = kind === "sqlite" ? sqlitePath(url) : undefined;
    const readOnly = path === undefined ? undefined : await sqliteSourceMode(path);
    const driver = await openSqlDriver(connectionUrl(kind, url), readOnly ? { readOnly } : {});
    try {
      if (!(await withTimeout(supportedSqlSchema(driver)))) throw new CopyRefusedError(SQL_SCHEMA);
    } catch (error) {
      await closeWithin(driver);
      throw error;
    }
    return {
      stores: createSqlStores(driver),
      close: () => driver.close(),
      kind,
      // Nothing locks an immutable file: a service that opened it meanwhile left -wal or -shm files.
      ...(path !== undefined && readOnly === "immutable"
        ? { untouched: async () => !(await sqliteSidecars(path)) }
        : {}),
    };
  }
  const { createMongoStores } = await import("../mongo.js");
  const client = await connectMongoClient(url, {});
  return {
    stores: createMongoStores(client.db()),
    close: () => client.close(),
    kind: "mongodb",
    mongoClient: client,
  };
}

/**
 * Opens the destination after the same-database and emptiness checks. `writing` runs right before
 * its first write (index or schema creation).
 */
async function openDestination(
  url: string,
  kind: ReturnType<typeof storageKindFromUrl>,
  writing: () => void,
  source?: MongoServer,
): Promise<OpenedStores> {
  if (kind === "mongodb") {
    const [{ createMongoStores, ensureIndexes }, { createMongoTransferBackend }] =
      await Promise.all([import("../mongo.js"), import("./mongo.js")]);
    // No retried writes; majority writes, so the majority reads of verification see them, with a
    // bounded wait for replication.
    const client = await connectMongoClient(url, {
      retryWrites: false,
      writeConcern: { w: "majority", wtimeoutMS: WRITE_CONCERN_TIMEOUT_MS },
    });
    try {
      await checkMongoDestination(client, source);
      const db = client.db();
      if (!(await createMongoTransferBackend(db).isEmpty())) throw new CopyRefusedError(NOT_EMPTY);
      writing();
      await ensureIndexes(db);
      return {
        stores: createMongoStores(db),
        close: () => client.close(),
        kind: "mongodb",
        mongoClient: client,
      };
    } catch (error) {
      await closeWithin(client);
      throw error;
    }
  }
  // The emptiness check and the close of its connection are each bounded.
  if (kind !== "memory") {
    const driver = await openSqlDriver(connectionUrl(kind, url));
    try {
      if (!(await withTimeout(createSqlTransferBackend(driver).isEmpty())))
        throw new CopyRefusedError(NOT_EMPTY);
    } finally {
      await closeWithin(driver);
    }
  }
  writing();
  return openWithin(openStores(connectionUrl(kind, url)));
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
  const windowMinutes = options.windowMinutes ?? COPY_WINDOW_MINUTES.default;
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < COPY_WINDOW_MINUTES.min ||
    windowMinutes > COPY_WINDOW_MINUTES.max
  )
    throw new CopyRefusedError(WINDOW_RANGE);
  let fromKind: ReturnType<typeof storageKindFromUrl>;
  let toKind: ReturnType<typeof storageKindFromUrl>;
  try {
    fromKind = storageKindFromUrl(fromUrl);
    toKind = storageKindFromUrl(toUrl);
  } catch {
    throw new CopyRefusedError("Unsupported database URL scheme");
  }

  if (sqliteUri(fromKind, fromUrl) || sqliteUri(toKind, toUrl))
    throw new CopyRefusedError(SQLITE_URI);
  const open = options.openStores;
  // The test seam may open in-memory stores; real runs must leave a database behind.
  if (!open && !(persistentDatabase(fromKind, fromUrl) && persistentDatabase(toKind, toUrl)))
    throw new CopyRefusedError(NOT_PERSISTENT);
  let source: OpenedSource | undefined;
  let destination: OpenedStores | undefined;
  let copiedCounts = emptyCounts();
  let destinationWritten = false;
  const writing = () => {
    destinationWritten = true;
  };
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
      writing();
      destination = await open(toUrl);
      if (destination.mongoClient)
        await checkMongoDestination(destination.mongoClient, sourceServer);
    } else destination = await openDestination(toUrl, toKind, writing, sourceServer);
    const destinationTransfer = transferBackend(destination.stores);
    if (!(await destinationTransfer.isEmpty())) throw new CopyRefusedError(NOT_EMPTY);

    // One fixed cutoff for every read below. Records expiring at or before it are skipped like
    // expired ones, and the run must end well before it (allowing for clock skew), so no record
    // the reads include can reach its expiry, and a TTL deletion, while they run. Elapsed time
    // comes from the monotonic clock, which wall-clock changes do not move.
    const margin = windowMinutes * 60_000;
    const deadline = margin - DEADLINE_RESERVE_MS;
    const started = performance.now();
    const cutoff = new Date(Date.now() + margin);
    const inTime = () => {
      if (performance.now() - started >= deadline)
        throw new CopyDeadlineError({ ...copiedCounts }, deadline / 60_000);
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
    const untouched = (await source.untouched?.()) ?? true;
    // After the last read: matching reads prove nothing once a TTL deletion could have run.
    inTime();
    if (
      !untouched ||
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
    throw new CopyFailureError({ ...copiedCounts }, code, destinationWritten);
  } finally {
    await closeWithin(destination);
    await closeWithin(source);
  }
}

function safeDriverCode(error: unknown, seen = new Set<object>()): string | undefined {
  const sqlCode = sqlErrorCode(error);
  if (sqlCode) return sqlCode;
  if (error instanceof Error && error.name === "MongoNetworkTimeoutError") return "ETIMEDOUT";
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
