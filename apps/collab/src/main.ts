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
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, flushing and shutting down`);
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
