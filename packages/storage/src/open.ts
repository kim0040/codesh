import type { MongoClient } from "mongodb";
import { createMemoryStores } from "./memory.js";
import { openSqlDriver, sqlErrorCode } from "./sql/driver.js";
import { ensureSqlSchema } from "./sql/schema.js";
import { createSqlStores } from "./sql/stores.js";
import type { Stores } from "./types.js";

export type StorageKind = "memory" | "mongodb" | "sqlite" | "postgresql" | "mysql";

export interface OpenedStores {
  stores: Stores;
  close(): Promise<void>;
  kind: StorageKind;
  /** Present only for MongoDB, whose existing heartbeat diagnostics are retained. */
  mongoClient?: MongoClient;
}

export interface OpenStoresOptions {
  mongoServerSelectionTimeoutMS?: number;
  /** false opens an existing SQL database as it is, without migrating it (for the copy's source). */
  migrate?: boolean;
}

export function storageKindFromUrl(url: string): StorageKind {
  if (url === "memory:" || url === "memory://") return "memory";
  if (/^mongodb(?:\+srv)?:\/\//.test(url)) return "mongodb";
  if (url.startsWith("sqlite:")) return "sqlite";
  if (/^(postgres|postgresql):\/\//.test(url)) return "postgresql";
  if (/^(mysql|mariadb):\/\//.test(url)) return "mysql";
  throw new Error("Unsupported database URL scheme");
}

/** Opens the selected backend. Driver imports and error text are kept independent of URL contents. */
export async function openStores(
  url: string,
  options: OpenStoresOptions = {},
): Promise<OpenedStores> {
  const kind = storageKindFromUrl(url);
  if (kind === "memory")
    return { stores: createMemoryStores(), close: async () => undefined, kind: "memory" };

  if (kind === "mongodb") {
    try {
      const { connectMongo, createMongoStores, ensureIndexes } = await import("./mongo.js");
      const connection = await connectMongo(url, {
        serverSelectionTimeoutMS: options.mongoServerSelectionTimeoutMS,
      });
      try {
        await ensureIndexes(connection.db);
      } catch {
        await connection.close();
        throw new Error("MongoDB storage initialization failed");
      }
      return {
        stores: createMongoStores(connection.db),
        close: connection.close,
        kind: "mongodb",
        mongoClient: connection.client,
      };
    } catch {
      throw new Error("MongoDB storage could not be opened");
    }
  }

  let driver: Awaited<ReturnType<typeof openSqlDriver>> | undefined;
  let step = "connection";
  try {
    driver = await openSqlDriver(url);
    await driver.all("SELECT 1");
    if (options.migrate !== false) {
      step = "migration";
      await ensureSqlSchema(driver);
    }
    return {
      stores: createSqlStores(driver),
      close: () => driver?.close() ?? Promise.resolve(),
      kind,
    };
  } catch (error) {
    await driver?.close().catch(() => undefined);
    const code = sqlErrorCode(error);
    throw new Error(`${kind} storage ${step} failed${code ? ` (${code})` : ""}`);
  }
}
