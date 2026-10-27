import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { OpenedStores } from "../open.js";
import { openStores, storageKindFromUrl } from "../open.js";
import { openSqlDriver, sqlErrorCode } from "../sql/driver.js";
import { transferBackend } from "./registry.js";
import { createSqlTransferBackend } from "./sql.js";
import {
  TRANSFER_KINDS,
  type TransferBackend,
  type TransferCounts,
  type TransferRecord,
  type TransferUpload,
} from "./types.js";

const BATCH_RECORDS = 64;
const BATCH_BYTES = 2 * 1024 * 1024;

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

function stable(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.getTime() };
  if (value instanceof Uint8Array) return { $bytes: value.byteLength };
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
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

class TransferDigest {
  readonly counts = emptyCounts();
  private readonly hashes = new Map(TRANSFER_KINDS.map((kind) => [kind, createHash("sha256")]));

  addRecord(item: TransferRecord): void {
    this.counts[item.kind]++;
    const data = recordBytes(item);
    this.addHeader(item.kind, withoutBytes(item), data?.byteLength ?? 0);
    if (data) this.hashes.get(item.kind)?.update(data);
    this.hashes.get(item.kind)?.update("\n");
  }

  async addUpload(item: TransferUpload, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    this.counts.uploads++;
    this.addHeader("uploads", { record: item.record, createdAt: item.createdAt }, item.record.size);
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > item.record.size) throw new Error("Upload content exceeded its stored size");
      this.hashes.get("uploads")?.update(chunk);
    }
    if (size !== item.record.size) throw new Error("Upload content did not match its stored size");
    this.hashes.get("uploads")?.update("\n");
  }

  trackUpload(item: TransferUpload): AsyncIterable<Uint8Array> {
    this.counts.uploads++;
    this.addHeader("uploads", { record: item.record, createdAt: item.createdAt }, item.record.size);
    const hash = this.hashes.get("uploads");
    let size = 0;
    const source = item.chunks;
    return (async function* () {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > item.record.size) throw new Error("Upload content exceeded its stored size");
        hash?.update(chunk);
        yield chunk;
      }
      if (size !== item.record.size)
        throw new Error("Upload content did not match its stored size");
      hash?.update("\n");
    })();
  }

  digest(): string {
    const hash = createHash("sha256");
    for (const kind of TRANSFER_KINDS) {
      hash.update(`${kind}:${this.counts[kind]}:${this.hashes.get(kind)?.digest("hex")}\n`);
    }
    return hash.digest("hex");
  }

  private addHeader(kind: string, record: unknown, bytes: number): void {
    this.hashes
      .get(kind as (typeof TRANSFER_KINDS)[number])
      ?.update(`${JSON.stringify(stable(record))}\n${bytes}\n`);
  }
}

function itemSize(item: TransferRecord): number {
  const data = recordBytes(item);
  return Buffer.byteLength(JSON.stringify(stable(withoutBytes(item)))) + (data?.byteLength ?? 0);
}

function databaseIdentity(url: string): string {
  const kind = storageKindFromUrl(url);
  if (kind === "memory") return `${kind}:${url}`;
  if (kind === "sqlite") {
    const path = url.slice("sqlite:".length);
    if (path.includes(":memory:")) return `sqlite:${path}`;
    try {
      const parsed = new URL(url);
      return `sqlite:${resolve(decodeURIComponent(parsed.pathname))}`;
    } catch {
      return `sqlite:${resolve(path)}`;
    }
  }
  const parsed = new URL(url);
  const dialect = kind === "mysql" ? "mysql" : kind;
  return `${dialect}:${parsed.hostname.toLowerCase()}:${parsed.port}:${decodeURIComponent(parsed.pathname)}`;
}

function sameDatabase(fromUrl: string, toUrl: string): boolean {
  return fromUrl === toUrl || databaseIdentity(fromUrl) === databaseIdentity(toUrl);
}

function mongoDestinationUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("retryWrites", "false");
  return parsed.toString();
}

async function destinationWasEmptyBeforeOpening(
  url: string,
  kind: ReturnType<typeof storageKindFromUrl>,
): Promise<boolean> {
  if (kind === "memory") return true;
  if (kind === "mongodb") {
    const { connectMongo } = await import("../mongo.js");
    const connection = await connectMongo(url);
    try {
      const { createMongoTransferBackend } = await import("./mongo.js");
      return await createMongoTransferBackend(connection.db).isEmpty();
    } finally {
      await connection.close();
    }
  }
  const driver = await openSqlDriver(url);
  try {
    return await createSqlTransferBackend(driver).isEmpty();
  } finally {
    await driver.close();
  }
}

async function verify(backend: TransferBackend, expected: TransferDigest): Promise<string> {
  const actual = new TransferDigest();
  for await (const item of backend.exportAll()) {
    if (item.kind === "uploads") await actual.addUpload(item, item.chunks);
    else actual.addRecord(item);
  }
  const actualDigest = actual.digest();
  const expectedCounts = JSON.stringify(expected.counts);
  const actualCounts = JSON.stringify(actual.counts);
  if (expectedCounts !== actualCounts || expected.digest() !== actualDigest)
    throw new CopyVerificationError({ ...expected.counts });
  return actualDigest;
}

async function copyRecords(
  source: TransferBackend,
  destination: TransferBackend,
  digest: TransferDigest,
  batchRecords: number,
  batchBytes: number,
): Promise<void> {
  let batch: TransferRecord[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await destination.importBatch(batch);
    batch = [];
    size = 0;
  };

  for await (const item of source.exportAll()) {
    if (item.kind === "uploads") {
      await flush();
      await destination.importUpload(item.record, item.createdAt, digest.trackUpload(item));
      continue;
    }

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
  let toKind: ReturnType<typeof storageKindFromUrl>;
  try {
    storageKindFromUrl(fromUrl);
    toKind = storageKindFromUrl(toUrl);
  } catch {
    throw new CopyRefusedError("Unsupported database URL scheme");
  }
  if (sameDatabase(fromUrl, toUrl))
    throw new CopyRefusedError("Source and destination are the same");

  const open = options.openStores ?? openStores;
  let source: OpenedStores | undefined;
  let destination: OpenedStores | undefined;
  let copiedCounts = emptyCounts();
  try {
    if (!options.openStores && !(await destinationWasEmptyBeforeOpening(toUrl, toKind)))
      throw new CopyRefusedError("Destination is not empty");
    source = await open(fromUrl);
    destination = await open(toKind === "mongodb" ? mongoDestinationUrl(toUrl) : toUrl);
    const sourceTransfer = transferBackend(source.stores);
    const destinationTransfer = transferBackend(destination.stores);
    if (!(await destinationTransfer.isEmpty()))
      throw new CopyRefusedError("Destination is not empty");

    const digest = new TransferDigest();
    copiedCounts = digest.counts;
    await copyRecords(
      sourceTransfer,
      destinationTransfer,
      digest,
      Math.max(1, options.batchRecords ?? BATCH_RECORDS),
      Math.max(1024, options.batchBytes ?? BATCH_BYTES),
    );
    await destinationTransfer.recomputeCounters();
    const copiedDigest = await verify(destinationTransfer, digest);
    return { counts: digest.counts, digest: copiedDigest };
  } catch (error) {
    if (error instanceof CopyRefusedError || error instanceof CopyVerificationError) throw error;
    if (error instanceof CopyFailureError) throw error;
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
