import { diagnosticError } from "@gachipad/shared";
import {
  connectMongo,
  crashDiagnosticPath,
  createMongoStores,
  ensureIndexes,
  ingestCrashDiagnostic,
  writeCrashDiagnostic,
} from "@gachipad/storage";
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
const crashPath = crashDiagnosticPath("collab");
ingestCrashDiagnostic(crashPath, server.diagnostics);

let mongoFailed = false;
mongo.client.on("serverHeartbeatFailed", (event) => {
  mongoFailed = true;
  const failure = event && typeof event === "object" && "failure" in event ? event.failure : event;
  server.diagnostics.record("mongo_error", diagnosticError(failure), "error");
});
mongo.client.on("serverHeartbeatSucceeded", () => {
  if (mongoFailed) {
    mongoFailed = false;
    server.diagnostics.record("mongo_recovered");
  }
});
process.on("uncaughtExceptionMonitor", (error) => {
  const details = diagnosticError(error);
  writeCrashDiagnostic(crashPath, "uncaught", details);
  server.diagnostics.record("uncaught", details, "error");
});

/** Below the usual 30 s grace period of a container stop, so the log line still gets out. */
const SHUTDOWN_TIMEOUT_MS = 25_000;

// Unhandled work is fatal; write the scrubbed crash record before the process exits.
process.on("unhandledRejection", (reason) => {
  const details = diagnosticError(reason);
  writeCrashDiagnostic(crashPath, "rejection", details);
  server.diagnostics.record("rejection", details, "error");
  console.error("collab: unhandled rejection", details);
  process.exit(1);
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
    console.error("collab: shutdown failed", diagnosticError(error));
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await server.listen();
console.log(`collab ${config.instanceId} listening on ${server.webSocketURL}${"/collab"}`);
