import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export interface CollabMetrics {
  registry: Registry;
  flushSeconds: Histogram;
  flushErrors: Counter;
  updates: Counter<"origin">;
  slowClients: Counter;
  refusedTooLarge: Counter;
}

/** Prometheus metrics of one collab instance; counts are read from Hocuspocus at scrape time. */
export function createMetrics(counts: () => { connections: number; documents: number }) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "codesh_collab_" });
  new Gauge({
    name: "codesh_collab_connections",
    help: "Open document connections",
    registers: [registry],
    collect() {
      this.set(counts().connections);
    },
  });
  new Gauge({
    name: "codesh_collab_documents_loaded",
    help: "Documents held in memory",
    registers: [registry],
    collect() {
      this.set(counts().documents);
    },
  });
  return {
    registry,
    flushSeconds: new Histogram({
      name: "codesh_collab_flush_seconds",
      help: "Duration of one update log write",
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    flushErrors: new Counter({
      name: "codesh_collab_flush_errors_total",
      help: "Failed update log writes (retried on the next tick)",
      registers: [registry],
    }),
    updates: new Counter({
      name: "codesh_collab_updates_total",
      help: "Yjs updates applied, by origin (connection, redis, local)",
      labelNames: ["origin"],
      registers: [registry],
    }),
    slowClients: new Counter({
      name: "codesh_collab_slow_client_closes_total",
      help: "Sockets closed with 4408 because their send buffer exceeded the limit",
      registers: [registry],
    }),
    refusedTooLarge: new Counter({
      name: "codesh_collab_refused_too_large_total",
      help: "Updates refused because the document would exceed maxDocBytes",
      registers: [registry],
    }),
  } satisfies CollabMetrics;
}
