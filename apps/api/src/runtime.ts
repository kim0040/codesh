import { diagnosticError } from "@codesh/shared";
import {
  connectMongo,
  createMemoryStores,
  createMongoStores,
  ensureIndexes,
  ServerDiagnostics,
} from "@codesh/storage";
import { Redis } from "ioredis";
import { ldapAdapter, oidcAdapter } from "./auth/real.js";
import type { Config } from "./config.js";
import type { Deps } from "./ctx.js";
import { Hub } from "./hub.js";
import { createMetrics } from "./metrics.js";

export interface Runtime {
  deps: Deps;
  close(): Promise<void>;
}
export async function createRuntime(config: Config): Promise<Runtime> {
  const valkey = new Redis(config.valkeyUrl);
  const subscriber = valkey.duplicate();
  const mongo =
    config.storage === "mongo"
      ? await connectMongo(config.mongoUrl, { serverSelectionTimeoutMS: 30_000 })
      : null;
  if (mongo) await ensureIndexes(mongo.db);
  const stores = mongo ? createMongoStores(mongo.db) : createMemoryStores();
  const diagnostics = new ServerDiagnostics(
    "api",
    stores.diagnostics,
    process.env.INSTANCE_ID ?? "api",
  );
  let mongoFailed = false;
  mongo?.client.on("serverHeartbeatFailed", (event) => {
    mongoFailed = true;
    const failure =
      event && typeof event === "object" && "failure" in event ? event.failure : event;
    diagnostics.record("mongo_error", diagnosticError(failure), "error");
  });
  mongo?.client.on("serverHeartbeatSucceeded", () => {
    if (mongoFailed) {
      mongoFailed = false;
      diagnostics.record("mongo_recovered");
    }
  });
  return {
    deps: {
      config,
      stores,
      valkey,
      diagnostics,
      hub: new Hub(subscriber),
      metrics: createMetrics(),
      oidc: oidcAdapter,
      ldap: ldapAdapter,
    },
    async close() {
      subscriber.disconnect();
      await valkey.quit().catch(() => undefined);
      await mongo?.close();
    },
  };
}
