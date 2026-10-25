import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DiagnosticDetails,
  type DiagnosticEvent,
  type DiagnosticKind,
  type DiagnosticLevel,
  DiagnosticRing,
  type DiagnosticSnapshot,
  type DiagnosticSource,
  diagnosticError,
  renamedEnv,
  scrubDiagnosticDetails,
} from "@gachipad/shared";
import type { DiagnosticsStore } from "./types.js";

/** 8 fixed slots per source, each <=384 KiB including <=256 KiB/500 events; total <=6 MiB serialized.
 * Slots restore earlier events on restart and may combine colliding instances, never grow with uptime.
 * One pending snapshot and one in flight per process; no DB work on a request/update path.
 */
export class ServerDiagnostics {
  readonly ring = new DiagnosticRing();
  readonly bootId = randomUUID();
  private dirty = false;
  private writing = false;
  private writeDone: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private recentCache:
    | { at: number; value: { events: DiagnosticEvent[]; snapshots: DiagnosticSnapshot[] } }
    | undefined;
  private recentCacheDirty = false;
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
    at = Date.now(),
  ): void {
    this.ring.record(this.source, kind, details, level, at);
    if (this.recentCache) this.recentCacheDirty = true;
    if (level === "error") {
      const minute = Math.floor(at / 60_000);
      this.errorMinutes.set(
        minute,
        Math.min(Number.MAX_SAFE_INTEGER, (this.errorMinutes.get(minute) ?? 0) + 1),
      );
    }
    this.dirty = true;
  }
  start(): Promise<void> {
    this.starting ??= (async () => {
      try {
        const previous = (await this.store.list()).find((s) => s.slot === this.slot);
        if (previous) {
          this.ring.load({
            events: [...previous.events, ...this.ring.list()],
            breadcrumbs: [...(previous.breadcrumbs ?? []), ...this.ring.listBreadcrumbs()],
          });
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
      bootId: this.bootId,
      at: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      ...this.counts(),
      errorMinutes: [...this.errorMinutes.entries()],
      events: this.ring.list(),
      breadcrumbs: this.ring.listBreadcrumbs(),
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
    if (this.recentCache && Date.now() - this.recentCache.at < 5000) {
      if (this.recentCacheDirty) {
        const snapshots = this.recentCache.value.snapshots.filter((s) => s.slot !== this.slot);
        snapshots.push(this.snapshot());
        this.recentCache.value = {
          snapshots,
          events: snapshots
            .flatMap((snapshot) => snapshot.events)
            .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
        };
        this.recentCacheDirty = false;
      }
      return this.recentCache.value;
    }
    const stored = await this.store.list().catch((error: unknown) => {
      this.record("mongo_error", diagnosticError(error), "error");
      return [];
    });
    const snapshots = stored.filter(
      (s) => Date.parse(s.at) >= Date.now() - 14 * 86400_000 && s.slot !== this.slot,
    );
    snapshots.push(this.snapshot());
    const cleanSnapshots = snapshots.map((snapshot) => {
      const ring = new DiagnosticRing();
      ring.load({ events: snapshot.events, breadcrumbs: snapshot.breadcrumbs });
      return {
        ...snapshot,
        events: ring.list(),
        breadcrumbs: ring.listBreadcrumbs(),
      };
    });
    const value = {
      snapshots: cleanSnapshots,
      events: cleanSnapshots
        .flatMap((snapshot) => snapshot.events)
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    };
    this.recentCache = { at: Date.now(), value };
    this.recentCacheDirty = false;
    return value;
  }
}

export type CrashDiagnosticKind = Extract<DiagnosticKind, "uncaught" | "rejection">;

/** Small, scrubbed crash records survive a Node process restart within its writable temp area. */
export function crashDiagnosticPath(source: "api" | "collab"): string {
  const dataDir = renamedEnv(process.env, "GACHIPAD_DATA_DIR") ?? process.env.DATA_DIR;
  // legacy codesh name (1.0.x); remove in 2.0
  const legacy = join(tmpdir(), "codesh", "tmp", `${source}-crash.json`);
  if (!dataDir && existsSync(legacy)) return legacy;
  return dataDir
    ? join(dataDir, "tmp", `${source}-crash.json`)
    : join(tmpdir(), "gachipad", "tmp", `${source}-crash.json`);
}

export function writeCrashDiagnostic(
  path: string,
  kind: CrashDiagnosticKind,
  details: unknown,
  at = Date.now(),
): void {
  try {
    const payload = JSON.stringify({ kind, details: scrubDiagnosticDetails(details), at });
    if (Buffer.byteLength(payload) > 8192) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, payload, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* A crash reporter must never delay or replace the original process failure. */
  }
}

export function ingestCrashDiagnostic(path: string, diagnostics: ServerDiagnostics): boolean {
  let value: unknown;
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > 8192) throw new Error("crash record too large");
    value = JSON.parse(text);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* Missing or inaccessible temp files do not prevent startup. */
    }
    return false;
  }
  try {
    if (!value || typeof value !== "object") return false;
    const record = value as { kind?: unknown; details?: unknown; at?: unknown };
    if (record.kind !== "uncaught" && record.kind !== "rejection") return false;
    const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now();
    diagnostics.record(record.kind, scrubDiagnosticDetails(record.details), "error", at);
    return true;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* It is safe to leave a failed cleanup for startup's next attempt. */
    }
  }
}

/** Internal admin counts only. This reference is never included in an exported bundle. */
export const diagnosticShareRef = (secret: string, id: string) =>
  createHmac("sha256", secret).update(id).digest("hex").slice(0, 16);
