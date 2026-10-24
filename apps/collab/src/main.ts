import { connectMongo, createMongoStores, ensureIndexes } from "@codesh/storage";
import { loadConfig } from "./config.js";
import { createCollabServer } from "./server.js";

const config = loadConfig();
const mongo = await connectMongo(config.mongoUrl);
await ensureIndexes(mongo.db);
const server = createCollabServer({
  port: config.port,
  address: config.host,
  quiet: config.production,
  stores: createMongoStores(mongo.db),
  valkeyUrl: config.valkeyUrl,
  secret: config.collabSecret,
  instanceId: config.instanceId,
  timings:
    config.broadcastWindowMs === undefined
      ? undefined
      : { broadcastWindowMs: config.broadcastWindowMs },
});

/** Below the usual 30 s grace period of a container stop, so the log line still gets out. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

// One failed background task must not end the process and drop every open doc with it.
process.on("unhandledRejection", (reason) => {
  console.error("collab: unhandled rejection", reason);
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, flushing and shutting down`);
  setTimeout(() => {
    console.error(`collab: shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS} ms, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await server.destroy();
    await mongo.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await server.listen();
console.log(`collab ${config.instanceId} listening on ${server.webSocketURL}${"/collab"}`);
