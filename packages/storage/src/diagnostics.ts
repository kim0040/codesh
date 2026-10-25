import { createHash, createHmac } from "node:crypto";
import {
  type DiagnosticDetails,
  type DiagnosticEvent,
  type DiagnosticKind,
  type DiagnosticLevel,
  DiagnosticRing,
  type DiagnosticSnapshot,
  type DiagnosticSource,
} from "@codesh/shared";
import type { DiagnosticsStore } from "./types.js";

/** 8 fixed slots per source, each <=384 KiB including <=256 KiB/500 events; total <=6 MiB serialized.
 * Slots restore earlier events on restart and may combine colliding instances, never grow with uptime.
 * One pending snapshot and one in flight per process; no DB work on a request/update path.
 */
export class ServerDiagnostics {
  readonly ring = new DiagnosticRing();
  private dirty = false;
  private writing = false;
  private writeDone: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private readonly errorMinutes = new Map<number, number>();
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly slot: string;
  constructor(
    private readonly source: Exclude<DiagnosticSource, "client">,
    private readonly store: DiagnosticsStore,
    instance = "default",
    private readonly counts: () => {
      documents: number;
      connections: number;
      participants?: Record<string, number>;
    } = () => ({ documents: 0, connections: 0 }),
  ) {
    this.slot = `${source}:${(createHash("sha256").update(instance).digest()[0] ?? 0) % 8}`;
  }
  record(
    kind: DiagnosticKind,
    details: DiagnosticDetails = {},
    level: DiagnosticLevel = "warn",
  ): void {
    this.ring.record(this.source, kind, details, level);
    if (level === "error") {
      const minute = Math.floor(Date.now() / 60_000);
      this.errorMinutes.set(
        minute,
        Math.min(Number.MAX_SAFE_INTEGER, (this.errorMinutes.get(minute) ?? 0) + 1),
      );
      this.pruneErrors();
    }
    this.dirty = true;
  }
  start(): Promise<void> {
    this.starting ??= (async () => {
      try {
        const previous = (await this.store.list()).find((s) => s.slot === this.slot);
        if (previous) {
          this.ring.load([...previous.events, ...this.ring.list()]);
          for (const [minute, count] of previous.errorMinutes ?? [])
            this.errorMinutes.set(
              minute,
              Math.min(Number.MAX_SAFE_INTEGER, (this.errorMinutes.get(minute) ?? 0) + count),
            );
          this.pruneErrors();
        }
      } catch {
        /* Diagnostics must not prevent startup when its mirror is unavailable. */
      }
      this.timer = setInterval(() => {
        void this.flush(true);
      }, 5000);
      this.timer.unref();
    })();
    return this.starting;
  }
  private pruneErrors(): void {
    const oldest = Math.floor(Date.now() / 60_000) - 1440;
    for (const minute of this.errorMinutes.keys())
      if (minute < oldest) this.errorMinutes.delete(minute);
  }
  snapshot(): DiagnosticSnapshot {
    this.pruneErrors();
    return {
      slot: this.slot,
      source: this.source,
      at: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      ...this.counts(),
      errorMinutes: [...this.errorMinutes.entries()],
      events: this.ring.list(),
    };
  }
  async flush(heartbeat = false): Promise<void> {
    if (this.writing || (!this.dirty && !heartbeat)) return;
    this.writing = true;
    this.dirty = false;
    try {
      const pending = this.store.replace(this.snapshot());
      this.writeDone = pending.catch(() => undefined);
      await pending;
    } catch {
      this.dirty = true;
    } finally {
      this.writing = false;
      this.writeDone = undefined;
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.writeDone;
    await this.flush(true);
  }
  /** Merge in-memory events with persisted snapshots, avoiding this process's stale mirror. */
  async recent(): Promise<{ events: DiagnosticEvent[]; snapshots: DiagnosticSnapshot[] }> {
    const stored = await this.store.list().catch(() => {
      this.record("mongo_error", {}, "error");
      return [];
    });
    const snapshots = stored.filter(
      (s) => Date.parse(s.at) >= Date.now() - 14 * 86400_000 && s.slot !== this.slot,
    );
    snapshots.push(this.snapshot());
    for (const snapshot of snapshots) {
      const ring = new DiagnosticRing();
      ring.load(snapshot.events);
      snapshot.events = ring.list();
    }
    return {
      snapshots,
      events: snapshots.flatMap((s) => s.events).sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    };
  }
}

/** Internal admin counts only. This reference is never included in an exported bundle. */
export const diagnosticShareRef = (secret: string, id: string) =>
  createHmac("sha256", secret).update(id).digest("hex").slice(0, 16);
