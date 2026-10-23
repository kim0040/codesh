import { DuplicateSeqError, type Stores } from "@codesh/storage";
import * as Y from "yjs";

/**
 * Persistence of one Y.Doc (§6.2-§6.5), independent of Hocuspocus so tests can drive it directly.
 *
 * Every update applied to the doc is appended to an in-memory buffer synchronously; nothing on that
 * path touches MongoDB. `flush()` writes the buffer as one log entry with the next `seq`,
 * `compact()` replaces the log with a snapshot. Only the instance holding the doc lock records and
 * writes (`owner`); all database work of one doc runs one at a time.
 */

export type PersistStores = Pick<Stores, "updates" | "snapshots">;

/** Yjs types its output as `Uint8Array<ArrayBufferLike>`; it is always backed by an ArrayBuffer. */
const bytes = (update: Uint8Array) => update as Uint8Array<ArrayBuffer>;

/** Transaction origin for state read from the database; such updates are not written back. */
export const LOAD_ORIGIN = { source: "local", skipStoreHooks: true } as const;

export interface PersistedDocOptions {
  /** Compact once this many log entries were written since the last compaction. */
  compactAfter: number;
  historyIntervalMs: number;
  now?: () => number;
  /** Called with the duration of every successful log write. */
  onFlush?: (ms: number) => void;
}

export interface LoadedState {
  /** Snapshot plus later updates merged into one update, or null for a new doc. */
  state: Uint8Array | null;
  /** Highest seq included. */
  seq: number;
  /** Log entries after the snapshot. */
  rows: number;
}

/** Latest compact snapshot plus the log entries after it (§6.4). */
export async function loadPersisted(stores: PersistStores, shareId: string): Promise<LoadedState> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await stores.snapshots.latest(shareId, "compact");
    const base = snapshot?.seq ?? 0;
    const entries = await stores.updates.read(shareId, base);
    // A compaction between the two reads deletes entries the snapshot we read does not cover;
    // the log is contiguous after a snapshot, so a gap means "read again".
    const first = entries[0];
    if (first && first.seq !== base + 1 && attempt < 3) continue;
    const parts = [...(snapshot ? [snapshot.state] : []), ...entries.map((e) => e.data)];
    return {
      state:
        parts.length === 0 ? null : parts.length === 1 ? (parts[0] ?? null) : Y.mergeUpdates(parts),
      seq: entries.at(-1)?.seq ?? base,
      rows: entries.length,
    };
  }
}

export class PersistedDoc {
  owner = false;
  /** Highest seq written by this instance (or found in the database when ownership started). */
  seq = 0;
  /** Bytes of the encoded state as of the last exact measurement plus everything applied since. */
  sizeEstimate = 0;
  private buffer: Uint8Array[] = [];
  private rowsSinceCompact = 0;
  private changedSinceHistory = false;
  private lastHistoryAt: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly listener = (update: Uint8Array, origin: unknown) => {
    this.sizeEstimate += update.byteLength;
    if (origin === LOAD_ORIGIN || !this.owner) return;
    this.buffer.push(update);
    this.changedSinceHistory = true;
  };

  constructor(
    readonly shareId: string,
    readonly doc: Y.Doc,
    private readonly stores: PersistStores,
    private readonly options: PersistedDocOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.lastHistoryAt = this.now();
  }

  /** Applies the stored state and starts recording. Call before any client update is applied. */
  async load(): Promise<void> {
    const loaded = await loadPersisted(this.stores, this.shareId);
    if (loaded.state) Y.applyUpdate(this.doc, loaded.state, LOAD_ORIGIN);
    this.seq = loaded.seq;
    this.rowsSinceCompact = loaded.rows;
    this.sizeEstimate = loaded.state?.byteLength ?? 0;
    this.doc.on("update", this.listener);
  }

  detach() {
    this.doc.off("update", this.listener);
  }

  get pendingUpdates(): number {
    return this.buffer.length;
  }

  get needsCompaction(): boolean {
    return this.owner && this.rowsSinceCompact >= this.options.compactAfter;
  }

  get historyDue(): boolean {
    return (
      this.owner &&
      this.changedSinceHistory &&
      this.now() - this.lastHistoryAt >= this.options.historyIntervalMs
    );
  }

  /** Re-measures the encoded size exactly. O(doc), so only used near a limit. */
  measure(): number {
    this.sizeEstimate = Y.encodeStateAsUpdate(this.doc).byteLength;
    return this.sizeEstimate;
  }

  /**
   * Becomes the writer, typically after another instance released or lost the lock. Merges what
   * the database has into the doc and writes the full state once, so nothing that only lived in
   * this instance's memory is lost.
   */
  adopt(): Promise<void> {
    return this.serial(async () => {
      const loaded = await loadPersisted(this.stores, this.shareId);
      if (loaded.state) Y.applyUpdate(this.doc, loaded.state, LOAD_ORIGIN);
      this.seq = Math.max(loaded.seq, await this.persistedSeq());
      this.rowsSinceCompact = loaded.rows;
      this.owner = true;
      this.buffer = [Y.encodeStateAsUpdate(this.doc)];
      this.changedSinceHistory = true;
      await this.writeBuffer();
    });
  }

  /** Stops writing; whoever owns the doc now has these updates through Valkey. */
  disown() {
    this.owner = false;
    this.buffer = [];
  }

  flush(): Promise<void> {
    return this.serial(() => this.writeBuffer());
  }

  /** Flush, then replace the log with a compact snapshot (§6.3). */
  compact(): Promise<void> {
    return this.serial(async () => {
      await this.writeBuffer();
      if (!this.owner || this.rowsSinceCompact === 0) return;
      const seq = this.seq;
      // May include updates still in the buffer; they get a later seq and re-applying is a no-op.
      const state = bytes(Y.encodeStateAsUpdate(this.doc));
      await this.stores.snapshots.put({
        shareId: this.shareId,
        seq,
        state,
        at: new Date(this.now()),
        kind: "compact",
      });
      await this.stores.updates.deleteUpTo(this.shareId, seq);
      await this.stores.snapshots.deleteBelow(this.shareId, "compact", seq);
      this.rowsSinceCompact = 0;
      this.sizeEstimate = state.byteLength;
    });
  }

  /** Writes a `history` snapshot when there was activity and the interval passed (or `force`). */
  history(force = false): Promise<void> {
    return this.serial(async () => {
      if (!this.owner || !this.changedSinceHistory) return;
      if (!force && this.now() - this.lastHistoryAt < this.options.historyIntervalMs) return;
      await this.writeBuffer();
      this.changedSinceHistory = false;
      this.lastHistoryAt = this.now();
      await this.stores.snapshots.put({
        shareId: this.shareId,
        seq: this.seq,
        state: bytes(Y.encodeStateAsUpdate(this.doc)),
        at: new Date(this.lastHistoryAt),
        kind: "history",
      });
    });
  }

  /** Resolves once every queued database operation finished. */
  idle(): Promise<void> {
    return this.serial(async () => {});
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async persistedSeq(): Promise<number> {
    const [logSeq, snapshot] = await Promise.all([
      this.stores.updates.lastSeq(this.shareId),
      this.stores.snapshots.latest(this.shareId, "compact"),
    ]);
    return Math.max(logSeq, snapshot?.seq ?? 0);
  }

  private async writeBuffer(): Promise<void> {
    if (!this.owner || this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];
    const data = pending.length === 1 ? (pending[0] as Uint8Array) : Y.mergeUpdates(pending);
    const seq = this.seq + 1;
    const started = performance.now();
    try {
      await this.stores.updates.append(this.shareId, [{ seq, data }], new Date(this.now()));
    } catch (error) {
      if (error instanceof DuplicateSeqError) {
        // Someone else wrote this seq (a lock that expired under load). Continue after their
        // entries and write everything we have, so the log is a superset of both writers.
        this.seq = await this.persistedSeq();
        this.buffer = [Y.encodeStateAsUpdate(this.doc), ...this.buffer];
      } else {
        this.buffer = [data, ...this.buffer];
      }
      throw error;
    }
    this.seq = seq;
    this.rowsSinceCompact++;
    this.options.onFlush?.(performance.now() - started);
  }
}
