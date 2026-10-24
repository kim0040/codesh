import { randomUUID } from "node:crypto";
import { connectMongo, createMongoStores, type Db, ensureIndexes } from "./mongo.js";
import type { Stores } from "./types.js";

/**
 * Helpers for integration tests against the dev services (`pnpm services:up`). Suites skip when
 * a service is unreachable, unless CODESH_REQUIRE_SERVICES=1 (the package `test` scripts set it).
 */

export const MONGO_TEST_URL = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017";
export const VALKEY_TEST_URL = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";
export const SERVICES_REQUIRED = process.env.CODESH_REQUIRE_SERVICES === "1";

/** Resolves to whether the suite should run; throws when services are required but missing. */
export async function requireService(name: string, probe: () => Promise<void>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (error) {
    if (SERVICES_REQUIRED)
      throw new Error(`${name} is required for this test run`, { cause: error });
    console.warn(`${name} unreachable, skipping its integration tests`);
    return false;
  }
}

export function mongoAvailable(): Promise<boolean> {
  return requireService("MongoDB", async () => {
    const connection = await connectMongo(MONGO_TEST_URL, { serverSelectionTimeoutMS: 1500 });
    await connection.close();
  });
}

export interface TestDatabase {
  db: Db;
  stores: Stores;
  /** Empties every collection (dropping would churn WiredTiger files on a shared machine). */
  reset(): Promise<Stores>;
  drop(): Promise<void>;
}

/** A database with a random name, so parallel test files never share data. */
export async function createTestDatabase(prefix = "codesh_test"): Promise<TestDatabase> {
  const connection = await connectMongo(MONGO_TEST_URL, {
    dbName: `${prefix}_${randomUUID().slice(0, 8)}`,
  });
  const { db } = connection;
  await ensureIndexes(db);
  return {
    db,
    stores: createMongoStores(db),
    async reset() {
      const collections = await db.collections();
      await Promise.all(collections.map((c) => c.deleteMany({})));
      return createMongoStores(db);
    },
    async drop() {
      await db.dropDatabase();
      await connection.close();
    },
  };
}
