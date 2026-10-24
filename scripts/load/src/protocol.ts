/**
 * Messages between the load coordinator (main.ts) and its client threads (worker.ts). Every
 * timestamp is `now()`: milliseconds since the epoch with sub-millisecond resolution, the same
 * clock in every thread of the process.
 */

export const now = () => performance.timeOrigin + performance.now();

export interface ClientJob {
  /** Sender id in awareness stamps, unique in the run. */
  key: string;
  group: string;
  shareId: string;
  /** Position of the share in the coordinator's list, used in compact delivery records. */
  shareIndex: number;
  /** Index among the share's writers, or null for a client that never types. */
  writer: number | null;
  /** Session cookie of a person the coordinator created (owner, student, teacher), or null. */
  cookie: string | null;
  /** Join body: the edit key for an editor. */
  body: Record<string, unknown>;
  /** Expected roles; empty accepts any. */
  roles: string[];
  /** Clients with the same socket key share one WebSocket (the lab teacher's tab). */
  socketKey: string | null;
  /** Keystrokes per second for a writer, cursor moves per second for anyone else. */
  perSecond: number;
}

export interface WorkerConfig {
  url: string;
  connectTimeoutS: number;
  concurrency: number;
}

export type ToWorker =
  | { type: "connect"; jobs: ClientJob[] }
  | { type: "start" }
  | { type: "storm"; kind: "drop" | "restart"; at: number }
  | { type: "stop" }
  /** Typed markers per `<shareIndex>:<writer>`, for the convergence check. */
  | { type: "check"; typed: Record<string, number> }
  | { type: "results" }
  | { type: "close" };

export interface Replica {
  key: string;
  shareIndex: number;
  synced: boolean;
  /** Hash and length of the text, to compare replicas without moving them. */
  hash: string;
  length: number;
  missing: number;
  duplicated: number;
  /** Last awareness stamp this client published, or -1. */
  awarenessLast: number;
  seen: [string, number][];
}

export interface StormRecord {
  key: string;
  wasSynced: boolean;
  lostAt: number | null;
  resyncedAt: number | null;
}

export interface GroupResults {
  awarenessMs: Float64Array;
  awarenessPublished: number;
}

export interface WorkerResults {
  /** Every edit delivery: share index, writer, seq and receive time, as parallel arrays. */
  rxShare: Float64Array;
  rxWriter: Float64Array;
  rxSeq: Float64Array;
  rxAt: Float64Array;
  /** Typing time of every marker by `<shareIndex>:<writer>`, indexed by seq. */
  typed: Record<string, Float64Array>;
  groups: Record<string, GroupResults>;
  storm: StormRecord[];
  failures: [string, number][];
  rateLimited: number;
  lagMs: { p50: number; p99: number; max: number };
}

export type FromWorker =
  | { type: "connected"; synced: number; connectMs: number[] }
  | { type: "started" }
  | { type: "stormed" }
  | { type: "stopped"; typed: Record<string, number> }
  | { type: "checked"; replicas: Replica[] }
  | { type: "results"; results: WorkerResults }
  | { type: "closed" };
