import { beforeEach, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ pg: [] as unknown[], mysql: [] as unknown[] }));

vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      pools.pg.push(options);
    }
    on() {}
  },
}));

vi.mock("mysql2/promise", () => ({
  createPool: (options: unknown) => {
    pools.mysql.push(options);
    return {};
  },
}));

const { openSqlDriver } = await import("./sql/driver.js");

describe("SQL pool options", () => {
  beforeEach(() => {
    pools.pg.length = 0;
    pools.mysql.length = 0;
  });

  it("bounds PostgreSQL connection and pool waits", async () => {
    await openSqlDriver("postgres://user:secret@db.invalid/gachipad");
    expect(pools.pg).toEqual([
      expect.objectContaining({ max: 10, connectionTimeoutMillis: 10_000 }),
    ]);
  });

  it("bounds MySQL connection setup and the prepared statement cache", async () => {
    await openSqlDriver("mariadb://user:secret@db.invalid/gachipad");
    const [options] = pools.mysql as { uri: string; maxPreparedStatements: number }[];
    expect(options?.maxPreparedStatements).toBe(256);
    const uri = new URL(options?.uri ?? "");
    expect(uri.protocol).toBe("mysql:");
    expect(uri.searchParams.get("connectTimeout")).toBe("10000");
  });

  it("keeps an explicit MySQL connectTimeout", async () => {
    await openSqlDriver("mysql://user:secret@db.invalid/gachipad?connectTimeout=3000");
    const [options] = pools.mysql as { uri: string }[];
    expect(new URL(options?.uri ?? "").searchParams.get("connectTimeout")).toBe("3000");
  });
});
