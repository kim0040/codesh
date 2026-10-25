import { setTimeout as delay } from "node:timers/promises";

export type SqlDialect = "sqlite" | "postgres" | "mysql";
export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  all<Row extends SqlRow = SqlRow>(sql: string, values?: unknown[]): Promise<Row[]>;
  run(sql: string, values?: unknown[]): Promise<number>;
}

export interface SqlDriver extends SqlExecutor {
  dialect: SqlDialect;
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function sqlitePath(url: string): string {
  if (url === "sqlite::memory:" || url === "sqlite://:memory:") return ":memory:";
  if (url.startsWith("sqlite:") && !url.startsWith("sqlite://")) return url.slice("sqlite:".length);
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  if (!path) throw new Error("SQLite database URL must include a path");
  return path;
}

class Queue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function sqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const errcode = "errcode" in error ? error.errcode : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    errcode === 5 ||
    errcode === 6 ||
    /database is locked/i.test(message)
  );
}

async function retrySqliteBusy<T>(work: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!sqliteBusy(error) || attempt >= 5) throw error;
      await delay(40 * 2 ** attempt);
    }
  }
}

/** Only callbacks containing replayable SQL belong in transactions; never consume streams here. */
async function retryTransaction<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (
        attempt >= 4 ||
        !["40P01", "40001", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(String(code))
      )
        throw error;
      await delay(10 * 2 ** attempt + Math.random() * 10);
    }
  }
}

/** Opens one driver connection. Database drivers are imported only for the selected URL scheme. */
export async function openSqlDriver(url: string): Promise<SqlDriver> {
  if (url.startsWith("sqlite:")) {
    // Node 22.23 exposes node:sqlite without a flag; it currently emits its documented
    // ExperimentalWarning when the first DatabaseSync connection is created.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(sqlitePath(url));
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;",
    );
    const queue = new Queue();
    const normalize = (values: unknown[]) =>
      values.map((value) => (typeof value === "boolean" ? Number(value) : value));
    const raw: SqlExecutor = {
      async all<Row extends SqlRow = SqlRow>(sql: string, values: unknown[] = []) {
        return db.prepare(sql).all(...(normalize(values) as never[])) as Row[];
      },
      async run(sql: string, values: unknown[] = []) {
        return Number(db.prepare(sql).run(...(normalize(values) as never[])).changes);
      },
    };
    return {
      dialect: "sqlite",
      all: (sql, values) => queue.run(() => retrySqliteBusy(() => raw.all(sql, values))),
      run: (sql, values) => queue.run(() => retrySqliteBusy(() => raw.run(sql, values))),
      async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        return queue.run(async () => {
          await retrySqliteBusy(() => db.exec("BEGIN IMMEDIATE"));
          try {
            const result = await work(raw);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original transaction failure.
            }
            throw error;
          }
        });
      },
      async close() {
        await queue.run(() => db.close());
      },
    };
  }

  if (/^(postgres|postgresql):\/\//.test(url)) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 10 });
    // Idle connection errors are returned to the caller through failed queries, not process logs.
    pool.on("error", () => undefined);
    const all = async <Row extends SqlRow = SqlRow>(sql: string, values: unknown[] = []) => {
      let index = 0;
      const translated = sql.replace(/\?/g, () => `$${++index}`);
      const result = await pool.query(translated, values);
      return result.rows as Row[];
    };
    const run = async (sql: string, values: unknown[] = []) => {
      let index = 0;
      const translated = sql.replace(/\?/g, () => `$${++index}`);
      return (await pool.query(translated, values)).rowCount ?? 0;
    };
    return {
      dialect: "postgres",
      all,
      run,
      async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        return retryTransaction(async () => {
          const client = await pool.connect();
          const tx: SqlExecutor = {
            async all<Row extends SqlRow = SqlRow>(sql: string, values: unknown[] = []) {
              let index = 0;
              const translated = sql.replace(/\?/g, () => `$${++index}`);
              return (await client.query(translated, values)).rows as unknown as Row[];
            },
            async run(sql, values = []) {
              let index = 0;
              const translated = sql.replace(/\?/g, () => `$${++index}`);
              return (await client.query(translated, values)).rowCount ?? 0;
            },
          };
          try {
            await client.query("BEGIN");
            const result = await work(tx);
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        });
      },
      async close() {
        await pool.end();
      },
    };
  }

  if (/^(mysql|mariadb):\/\//.test(url)) {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool(url.replace(/^mariadb:/, "mysql:"));
    const all = async <Row extends SqlRow = SqlRow>(sql: string, values: unknown[] = []) => {
      const [rows] = await pool.query(sql, values);
      return rows as Row[];
    };
    const run = async (sql: string, values: unknown[] = []) => {
      const [result] = await pool.query(sql, values);
      return "affectedRows" in result ? Number(result.affectedRows) : 0;
    };
    return {
      dialect: "mysql",
      all,
      run,
      async transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
        return retryTransaction(async () => {
          const connection = await pool.getConnection();
          const tx: SqlExecutor = {
            async all<Row extends SqlRow = SqlRow>(sql: string, values: unknown[] = []) {
              const [rows] = await connection.query(sql, values);
              return rows as unknown as Row[];
            },
            async run(sql, values = []) {
              const [result] = await connection.query(sql, values);
              return "affectedRows" in result ? Number(result.affectedRows) : 0;
            },
          };
          try {
            await connection.beginTransaction();
            const result = await work(tx);
            await connection.commit();
            return result;
          } catch (error) {
            await connection.rollback().catch(() => undefined);
            throw error;
          } finally {
            connection.release();
          }
        });
      },
      async close() {
        await pool.end();
      },
    };
  }

  throw new Error("Unsupported database URL scheme");
}

export function ignoreInsertSql(dialect: SqlDialect, table: string, columns: string[]): string {
  const names = columns.join(", ");
  const marks = columns.map(() => "?").join(", ");
  if (dialect === "mysql") return `INSERT IGNORE INTO ${table} (${names}) VALUES (${marks})`;
  return `INSERT INTO ${table} (${names}) VALUES (${marks}) ON CONFLICT DO NOTHING`;
}

export const supportsForUpdate = (dialect: SqlDialect) => dialect !== "sqlite";
