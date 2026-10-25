import { diagnosticError } from "@gachipad/shared";
import { openStores, ServerDiagnostics } from "@gachipad/storage";
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
  const storage = await openStores(config.databaseUrl, { mongoServerSelectionTimeoutMS: 30_000 });
  config.storage = storage.kind;
  const stores = storage.stores;
  const diagnostics = new ServerDiagnostics(
    "api",
    stores.diagnostics,
    process.env.INSTANCE_ID ?? "api",
  );
  let mongoFailed = false;
  storage.mongoClient?.on("serverHeartbeatFailed", (event) => {
    mongoFailed = true;
    const failure =
      event && typeof event === "object" && "failure" in event ? event.failure : event;
    diagnostics.record("mongo_error", diagnosticError(failure), "error");
  });
  storage.mongoClient?.on("serverHeartbeatSucceeded", () => {
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
      await storage.close();
    },
  };
}
