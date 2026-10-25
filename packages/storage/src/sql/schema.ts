import type { SqlDriver, SqlExecutor } from "./driver.js";
import { retrySqliteBusy } from "./driver.js";

const migrations: Array<{
  version: number;
  apply(tx: SqlExecutor, driver: SqlDriver): Promise<void>;
}> = [
  {
    version: 1,
    async apply(tx, driver) {
      const mysql = driver.dialect === "mysql";
      const bool = driver.dialect === "postgres" ? "BOOLEAN" : "INTEGER";
      const bytes = driver.dialect === "postgres" ? "BYTEA" : mysql ? "LONGBLOB" : "BLOB";
      const text = mysql ? "LONGTEXT" : "TEXT";
      const statements = [
        `CREATE TABLE IF NOT EXISTS shares (
          id VARCHAR(255) PRIMARY KEY, title ${text} NOT NULL, title_search ${text} NOT NULL, language VARCHAR(255) NOT NULL,
          owner_id VARCHAR(255) NOT NULL, lab_id VARCHAR(255), fork_of VARCHAR(255),
          created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_active_at BIGINT NOT NULL,
          expires_at BIGINT, saved ${bool} NOT NULL, access_json ${text} NOT NULL,
          join_code VARCHAR(255) NOT NULL, locked ${bool} NOT NULL, size_bytes BIGINT NOT NULL,
          preview ${text}, preview_at BIGINT
        )`,
        `CREATE TABLE IF NOT EXISTS share_saved_by (
          share_id VARCHAR(255) NOT NULL, client_id VARCHAR(255) NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY (share_id, client_id), FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS share_bans (
          share_id VARCHAR(255) NOT NULL, client_id VARCHAR(255) NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY (share_id, client_id), FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS share_updates (
          share_id VARCHAR(255) NOT NULL, seq BIGINT NOT NULL, data ${bytes} NOT NULL, at BIGINT NOT NULL,
          PRIMARY KEY (share_id, seq)
        )`,
        `CREATE TABLE IF NOT EXISTS share_snapshots (
          share_id VARCHAR(255) NOT NULL, kind VARCHAR(32) NOT NULL, seq BIGINT NOT NULL,
          at BIGINT NOT NULL, state ${bytes} NOT NULL, PRIMARY KEY (share_id, kind, seq)
        )`,
        `CREATE TABLE IF NOT EXISTS uploads (
          id VARCHAR(64) PRIMARY KEY, name VARCHAR(1024) NOT NULL, size BIGINT NOT NULL,
          content_type VARCHAR(255), owner_id VARCHAR(255) NOT NULL, share_id VARCHAR(255),
          expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, complete ${bool} NOT NULL, lease_until BIGINT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS upload_chunks (
          upload_id VARCHAR(64) NOT NULL, chunk_no INTEGER NOT NULL, data ${bytes} NOT NULL,
          PRIMARY KEY (upload_id, chunk_no), FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE IF NOT EXISTS upload_capacity (
          id INTEGER PRIMARY KEY, used_bytes BIGINT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS labs (
          id VARCHAR(255) PRIMARY KEY, title ${text} NOT NULL, owner_id VARCHAR(255) NOT NULL,
          join_code VARCHAR(255) NOT NULL, template_share_id VARCHAR(255), locked ${bool} NOT NULL,
          students_json ${text} NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS share_labels (
          client_id VARCHAR(255) NOT NULL, share_id VARCHAR(255) NOT NULL, folder ${text},
          tags_json ${text} NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (client_id, share_id)
        )`,
        `CREATE TABLE IF NOT EXISTS settings (
          id VARCHAR(255) PRIMARY KEY, value_json ${text} NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS audit (
          id VARCHAR(36) PRIMARY KEY, at BIGINT NOT NULL, actor VARCHAR(255) NOT NULL,
          ip VARCHAR(255) NOT NULL, action VARCHAR(255) NOT NULL, share_id VARCHAR(255), detail_json ${text}
        )`,
        `CREATE TABLE IF NOT EXISTS diagnostics (
          slot VARCHAR(32) PRIMARY KEY, value_json ${text} NOT NULL
        )`,
      ];
      for (const statement of statements)
        await tx.run(
          mysql
            ? statement
                .replace(/VARCHAR\(\d+\)/g, "$& CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
                .replace(
                  "title_search LONGTEXT",
                  "title_search LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
                )
            : statement,
        );

      const indexes: Array<[string, string]> = [
        ["shares_owner_id", "CREATE INDEX shares_owner_id ON shares(owner_id)"],
        [
          "shares_saved_by_client",
          "CREATE INDEX shares_saved_by_client ON share_saved_by(client_id, share_id)",
        ],
        ["shares_lab_id", "CREATE INDEX shares_lab_id ON shares(lab_id)"],
        ["shares_expires_at", "CREATE INDEX shares_expires_at ON shares(expires_at)"],
        ["shares_created_id", "CREATE INDEX shares_created_id ON shares(created_at, id)"],
        ["share_bans_client", "CREATE INDEX share_bans_client ON share_bans(client_id, share_id)"],
        [
          "share_snapshots_share_seq",
          "CREATE INDEX share_snapshots_share_seq ON share_snapshots(share_id, seq)",
        ],
        [
          "share_snapshots_kind_at",
          "CREATE INDEX share_snapshots_kind_at ON share_snapshots(kind, at)",
        ],
        [
          "uploads_name_created",
          mysql
            ? "CREATE INDEX uploads_name_created ON uploads(name(191), created_at)"
            : "CREATE INDEX uploads_name_created ON uploads(name, created_at)",
        ],
        ["uploads_expires", "CREATE INDEX uploads_expires ON uploads(expires_at)"],
        ["uploads_lease", "CREATE INDEX uploads_lease ON uploads(complete, lease_until)"],
        ["uploads_share", "CREATE INDEX uploads_share ON uploads(share_id)"],
        ["labs_expires", "CREATE INDEX labs_expires ON labs(expires_at)"],
        ["share_labels_share", "CREATE INDEX share_labels_share ON share_labels(share_id)"],
        ["audit_at_desc", "CREATE INDEX audit_at_desc ON audit(at)"],
      ];
      for (const [, statement] of indexes) {
        try {
          await tx.run(
            driver.dialect === "mysql"
              ? statement
              : statement.replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "),
          );
        } catch (error) {
          if (!mysql || !isDuplicateIndex(error)) throw error;
        }
      }
      await tx.run(
        driver.dialect === "mysql"
          ? "INSERT IGNORE INTO upload_capacity (id, used_bytes) VALUES (1, 0)"
          : "INSERT INTO upload_capacity (id, used_bytes) VALUES (1, 0) ON CONFLICT DO NOTHING",
      );
    },
  },
];

function isDuplicateIndex(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ER_DUP_KEYNAME" || error.code === "ER_DUP_INDEX")
  );
}

async function applyAvailable(tx: SqlExecutor, driver: SqlDriver): Promise<void> {
  await tx.run(
    driver.dialect === "mysql"
      ? "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)"
      : "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)",
  );
  const applied = new Set(
    (await tx.all<{ version: number }>("SELECT version FROM schema_version")).map((r) =>
      Number(r.version),
    ),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await migration.apply(tx, driver);
    if (driver.dialect === "mysql")
      await tx.run("INSERT IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)", [
        migration.version,
        Date.now(),
      ]);
    else
      await tx.run(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
        [migration.version, Date.now()],
      );
  }
}

/** Versioned, idempotent startup migration. MySQL's named lock covers implicit-commit DDL. */
export async function ensureSqlSchema(driver: SqlDriver): Promise<void> {
  if (driver.dialect === "mysql") {
    // GET_LOCK is scoped to a MySQL connection, so acquire, migrate, and release
    // through one transaction executor (which pins one pooled connection).
    await driver.transaction(async (tx) => {
      const lock = await tx.all<{ acquired: number }>("SELECT GET_LOCK(?, 15) AS acquired", [
        "gachipad_storage_schema",
      ]);
      if (Number(lock[0]?.acquired) !== 1)
        throw new Error("Could not acquire SQL schema migration lock");
      try {
        await applyAvailable(tx, driver);
      } finally {
        await tx.all("SELECT RELEASE_LOCK(?)", ["gachipad_storage_schema"]);
      }
    });
    return;
  }
  const migrate = () =>
    driver.transaction(async (tx) => {
      if (driver.dialect === "postgres") await tx.run("SELECT pg_advisory_xact_lock(731941102)");
      await applyAvailable(tx, driver);
    });
  if (driver.dialect === "sqlite") await retrySqliteBusy(migrate);
  else await migrate();
}

/** Test helper: clear domain rows without dropping the versioned schema. */
export async function resetSqlTables(driver: SqlDriver): Promise<void> {
  const tables = [
    "share_saved_by",
    "share_bans",
    "share_updates",
    "share_snapshots",
    "upload_chunks",
    "uploads",
    "labs",
    "share_labels",
    "shares",
    "settings",
    "audit",
    "diagnostics",
  ];
  await driver.transaction(async (tx) => {
    for (const table of tables) await tx.run(`DELETE FROM ${table}`);
    await tx.run("UPDATE upload_capacity SET used_bytes = 0 WHERE id = 1");
  });
}
