import { createMemoryStores, type Stores } from "@codesh/storage";
import { Redis } from "ioredis";
import { ldapAdapter, oidcAdapter } from "./auth/real.js";
import type { Config } from "./config.js";
import type { Deps } from "./ctx.js";
import { Hub } from "./hub.js";
import { createMetrics } from "./metrics.js";

interface MongoDb {
  readonly databaseName: string;
}
interface MongoModule {
  MongoClient: new (
    url: string,
  ) => { connect(): Promise<unknown>; db(): MongoDb; close(): Promise<void> };
}
interface StorageModule {
  createMongoStores?: (db: MongoDb) => Stores;
  ensureIndexes?: (db: MongoDb) => Promise<void>;
}

/**
 * The MongoDB stores are loaded lazily: `@codesh/storage` gains `createMongoStores(db)` and
 * `ensureIndexes(db)` in parallel work, and tests never need the driver.
 */
async function openStores(config: Config): Promise<{ stores: Stores; close: () => Promise<void> }> {
  if (config.storage === "memory") {
    return { stores: createMemoryStores(), close: async () => undefined };
  }
  const storage = (await import("@codesh/storage")) as unknown as StorageModule;
  if (!storage.createMongoStores || !storage.ensureIndexes) {
    throw new Error("@codesh/storage does not export createMongoStores / ensureIndexes yet");
  }
  const driver = "mongodb";
  const { MongoClient } = (await import(driver)) as MongoModule;
  const client = new MongoClient(config.mongoUrl);
  await client.connect();
  const db = client.db();
  await storage.ensureIndexes(db);
  return { stores: storage.createMongoStores(db), close: () => client.close() };
}

export interface Runtime {
  deps: Deps;
  close(): Promise<void>;
}

export async function createRuntime(config: Config): Promise<Runtime> {
  const valkey = new Redis(config.valkeyUrl);
  // A connection in subscriber mode cannot run other commands, so pub/sub gets its own.
  const subscriber = valkey.duplicate();
  const { stores, close: closeStores } = await openStores(config);
  return {
    deps: {
      config,
      stores,
      valkey,
      hub: new Hub(subscriber),
      metrics: createMetrics(),
      oidc: oidcAdapter,
      ldap: ldapAdapter,
    },
    async close() {
      subscriber.disconnect();
      await valkey.quit().catch(() => undefined);
      await closeStores();
    },
  };
}
