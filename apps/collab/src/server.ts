import { COLLAB_MAX_PAYLOAD_BYTES, namespace, SWEEPER_INTERVAL_MS } from "@codesh/shared";
import { diagnosticShareRef, ServerDiagnostics, type Stores } from "@codesh/storage";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { type Extension, Server } from "@hocuspocus/server";
import { Redis } from "ioredis";
import { Collab, type CollabTimings } from "./collab.js";
import { ValkeyLock } from "./lock.js";
import { type CollabMetrics, createMetrics } from "./metrics.js";
import { sweep } from "./sweeper.js";

export const COLLAB_PATH = "/collab";

export interface CollabOptions {
  port: number;
  address?: string;
  quiet?: boolean;
  stores: Stores;
  valkeyUrl: string;
  secret: string;
  /** Stable per instance (survives restarts) so a restarted process takes its doc locks back. */
  instanceId: string;
  timings?: Partial<CollabTimings>;
  /** 0 disables the sweeper. */
  sweeperIntervalMs?: number;
}

export interface CollabServer {
  server: Server;
  diagnostics: ServerDiagnostics;
  collab: Collab;
  metrics: CollabMetrics;
  readonly httpURL: string;
  readonly webSocketURL: string;
  listen(): Promise<void>;
  /** Graceful stop (§6.6): flush, compact, release locks, close connections. */
  destroy(): Promise<void>;
}

/**
 * Serves `GET /healthz` (liveness), `GET /readyz` (MongoDB and Valkey answer) and `GET /metrics`,
 * and only accepts WebSocket upgrades on `/collab`.
 */
function routes(metrics: CollabMetrics, ready: () => Promise<unknown>): Extension {
  return {
    extensionName: "routes",
    async onRequest({ request, response }) {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz") {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: true }));
      } else if (path === "/readyz") {
        const ok = await ready().then(
          () => true,
          () => false,
        );
        response
          .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok }));
      } else if (path === "/metrics") {
        const body = await metrics.registry.metrics();
        response.writeHead(200, { "Content-Type": metrics.registry.contentType }).end(body);
      } else {
        response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      }
      // A rejection without an error stops Hocuspocus from sending its default reply.
      return Promise.reject();
    },
    async onUpgrade({ request, socket }) {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== COLLAB_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return Promise.reject();
      }
    },
  };
}

export function createCollabServer(options: CollabOptions): CollabServer {
  let server: Server | undefined;
  const diagnostics = new ServerDiagnostics(
    "collab",
    options.stores.diagnostics,
    options.instanceId,
    () => ({
      connections: server?.hocuspocus.getConnectionsCount() ?? 0,
      documents: server?.hocuspocus.getDocumentsCount() ?? 0,
      participants: Object.fromEntries(
        [...(server?.hocuspocus.documents ?? new Map()).entries()]
          .slice(0, 1000)
          .map(([id, doc]) => [diagnosticShareRef(options.secret, id), doc.getConnectionsCount()]),
      ),
    }),
  );
  const redis = new Redis(options.valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectionName: `collab:${options.instanceId}`,
  });
  const subscriber = redis.duplicate({ connectionName: `collab:${options.instanceId}:sub` });
  // ioredis reconnects by itself; without listeners it reports every failed attempt as unhandled.
  let valkeyErrorAt = 0;
  const onValkeyError = (error: unknown) => {
    diagnostics.record("valkey_error", {}, "error");
    if (Date.now() - valkeyErrorAt < 10_000) return;
    valkeyErrorAt = Date.now();
    console.error("collab: Valkey connection error", error);
  };
  redis.on("error", onValkeyError);
  subscriber.on("error", onValkeyError);
  redis.on("ready", () => diagnostics.record("valkey_recovered"));
  subscriber.on("ready", () => diagnostics.record("valkey_recovered"));
  const metrics = createMetrics(() => ({
    connections: server?.hocuspocus.getConnectionsCount() ?? 0,
    documents: server?.hocuspocus.getDocumentsCount() ?? 0,
  }));
  const collab = new Collab({
    diagnostics,
    stores: options.stores,
    redis,
    subscriber,
    secret: options.secret,
    instanceId: options.instanceId,
    metrics,
    timings: options.timings,
  });
  server = new Server({
    port: options.port,
    address: options.address,
    quiet: options.quiet,
    name: options.instanceId,
    // Shutdown is owned by main.ts so that buffers are flushed before exit.
    stopOnSignals: false,
    // ws buffers a whole frame before anything can check it; its default limit is 100 MiB.
    websocketOptions: { maxPayload: COLLAB_MAX_PAYLOAD_BYTES },
    // §4: deleted content is dropped from memory and from every encoded state.
    yDocOptions: { gc: true, gcFilter: () => true },
    // Stores happen in the Collab extension; this only feeds extension-redis' store lock, which
    // takes Valkey round trips per run. The last disconnect still runs it at once.
    debounce: 5000,
    maxDebounce: 10_000,
    extensions: [
      routes(metrics, () => Promise.all([options.stores.settings.get(), redis.ping()])),
      collab,
      new RedisExtension({ redis, identifier: options.instanceId, prefix: `${namespace()}collab` }),
    ],
  });

  const sweeperLock = new ValkeyLock(redis, options.instanceId, 5 * 60_000);
  const sweeperIntervalMs = options.sweeperIntervalMs ?? SWEEPER_INTERVAL_MS;
  let sweeper: NodeJS.Timeout | undefined;
  let destroying: Promise<void> | undefined;
  const instance = server;

  return {
    server: instance,
    diagnostics,
    collab,
    metrics,
    get httpURL() {
      return instance.httpURL;
    },
    get webSocketURL() {
      return instance.webSocketURL;
    },
    async listen() {
      await diagnostics.start();
      await collab.start();
      await instance.listen();
      if (sweeperIntervalMs > 0) {
        // The lock value is this instance's id, so it does not keep a slow sweep of this same
        // instance from starting again.
        let sweeping = false;
        sweeper = setInterval(() => {
          if (sweeping) return;
          sweeping = true;
          sweep(options.stores, sweeperLock)
            .catch((error) => {
              diagnostics.record("background_error", {}, "error");
              console.error("collab: sweep failed", error);
            })
            .finally(() => {
              sweeping = false;
            });
        }, sweeperIntervalMs);
        sweeper.unref();
      }
    },
    destroy() {
      destroying ??= (async () => {
        clearInterval(sweeper);
        instance.httpServer.close();
        collab.beginShutdown();
        await instance.destroy();
        redis.disconnect();
        subscriber.disconnect();
        await diagnostics.close();
      })();
      return destroying;
    },
  };
}
