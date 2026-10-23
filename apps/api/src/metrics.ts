import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "codesh_api_" });
  return {
    registry,
    requests: new Histogram({
      name: "codesh_http_request_duration_seconds",
      help: "HTTP request duration",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    sharesCreated: new Counter({
      name: "codesh_shares_created_total",
      help: "Shares created",
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: "codesh_rate_limited_total",
      help: "Requests rejected by a rate limit",
      labelNames: ["bucket"] as const,
      registers: [registry],
    }),
    sseConnections: new Gauge({
      name: "codesh_sse_connections",
      help: "Open SSE streams",
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
