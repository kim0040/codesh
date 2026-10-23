import { namespace, SWEEPER_INTERVAL_MS } from "@codesh/shared";
import type { Stores } from "@codesh/storage";
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
  collab: Collab;
  metrics: CollabMetrics;
  readonly httpURL: string;
  readonly webSocketURL: string;
  listen(): Promise<void>;
  /** Graceful stop (§6.6): flush, compact, release locks, close connections. */
  destroy(): Promise<void>;
}

/** Serves `GET /healthz` and `GET /metrics`, and only accepts WebSocket upgrades on `/collab`. */
function routes(metrics: CollabMetrics): Extension {
  return {
    extensionName: "routes",
    async onRequest({ request, response }) {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz") {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ok: true }));
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
  const redis = new Redis(options.valkeyUrl, { maxRetriesPerRequest: 2 });
  const subscriber = redis.duplicate();
  let server: Server | undefined;
  const metrics = createMetrics(() => ({
    connections: server?.hocuspocus.getConnectionsCount() ?? 0,
    documents: server?.hocuspocus.getDocumentsCount() ?? 0,
  }));
  const collab = new Collab({
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
    // Stores happen in the Collab extension; this only feeds extension-redis' store lock.
    debounce: 1000,
    extensions: [
      routes(metrics),
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
    collab,
    metrics,
    get httpURL() {
      return instance.httpURL;
    },
    get webSocketURL() {
      return instance.webSocketURL;
    },
    async listen() {
      await collab.start();
      await instance.listen();
      if (sweeperIntervalMs > 0) {
        sweeper = setInterval(() => {
          sweep(options.stores, sweeperLock).catch((error) =>
            console.error("collab: sweep failed", error),
          );
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
      })();
      return destroying;
    },
  };
}
