import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export interface CollabMetrics {
  registry: Registry;
  flushSeconds: Histogram;
  flushErrors: Counter;
  updates: Counter<"origin">;
  slowClients: Counter;
  refusedTooLarge: Counter;
  messagesSent: Counter;
  bytesSent: Counter;
  awarenessDropped: Counter;
}

/** Prometheus metrics of one collab instance; counts are read from Hocuspocus at scrape time. */
export function createMetrics(counts: () => { connections: number; documents: number }) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "gachipad_collab_" });
  new Gauge({
    name: "gachipad_collab_connections",
    help: "Open document connections",
    registers: [registry],
    collect() {
      this.set(counts().connections);
    },
  });
  new Gauge({
    name: "gachipad_collab_documents_loaded",
    help: "Documents held in memory",
    registers: [registry],
    collect() {
      this.set(counts().documents);
    },
  });
  return {
    registry,
    flushSeconds: new Histogram({
      name: "gachipad_collab_flush_seconds",
      help: "Duration of one update log write",
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    flushErrors: new Counter({
      name: "gachipad_collab_flush_errors_total",
      help: "Failed update log writes (retried on the next tick)",
      registers: [registry],
    }),
    updates: new Counter({
      name: "gachipad_collab_updates_total",
      help: "Yjs updates applied, by origin (connection, redis, local)",
      labelNames: ["origin"],
      registers: [registry],
    }),
    slowClients: new Counter({
      name: "gachipad_collab_slow_client_closes_total",
      help: "Sockets closed with 4408 because their send buffer exceeded the limit",
      registers: [registry],
    }),
    refusedTooLarge: new Counter({
      name: "gachipad_collab_refused_too_large_total",
      help: "Updates refused because the document would exceed maxDocBytes",
      registers: [registry],
    }),
    messagesSent: new Counter({
      name: "gachipad_collab_ws_messages_sent_total",
      help: "WebSocket messages sent to clients",
      registers: [registry],
    }),
    bytesSent: new Counter({
      name: "gachipad_collab_ws_bytes_sent_total",
      help: "Bytes of the WebSocket messages sent to clients",
      registers: [registry],
    }),
    awarenessDropped: new Counter({
      name: "gachipad_collab_awareness_dropped_total",
      help: "Awareness updates from clients dropped by the per-connection rate limit",
      registers: [registry],
    }),
  } satisfies CollabMetrics;
}
