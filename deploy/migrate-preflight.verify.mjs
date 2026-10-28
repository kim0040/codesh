// Execute the production heredoc, including its real imports, rather than a second preflight.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const api = join(root, "apps/api");
const require = createRequire(join(api, "package.json"));
const tsx = require.resolve("tsx/esm");
const fixture = mkdtempSync(join(api, "node_modules/.migrate-preflight-"));
const entry = join(fixture, "preflight.mjs");
const source = join(fixture, "source.db");
const absent = join(fixture, "absent.db");
const sql = readFileSync(join(root, "deploy/migrate-db.sh"), "utf8");
const production = sql
  .split("<<'PREFLIGHT' || preflight_status=$?\n")[1]
  ?.split("\nPREFLIGHT\n")[0];
assert.ok(production, "production preflight heredoc must exist");
writeFileSync(entry, production);
writeFileSync(join(fixture, "handles.mjs"), "setInterval(() => {}, 1000);\n");
writeFileSync(
  join(fixture, "watchdog.mjs"),
  `import { register } from "node:module";
register("./loader.mjs", import.meta.url);
const original = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 120000 ? 3000 : ms, ...args);
setInterval(() => {}, 1000);
`,
);
writeFileSync(
  join(fixture, "loader.mjs"),
  `export async function resolve(specifier, context, next) {
  if (specifier === "mongodb") return { url: new URL("./mongo.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`,
);
writeFileSync(
  join(fixture, "mongo.mjs"),
  `export * from ${JSON.stringify(pathToFileURL(require.resolve("mongodb")).href)};
import { writeFileSync } from "node:fs";
const pending = () => { writeFileSync(process.env.STALL_REACHED, process.env.STALL); return new Promise(() => {}); };
export class MongoClient {
  async connect() { if (process.env.STALL === "open") await pending(); }
  db() { return { command: async () => {
    if (process.env.STALL === "query") await pending();
    return { dataSize: 0 };
  } }; }
  async close() { if (process.env.STALL === "close") await pending(); }
}
`,
);
let checks = 0;
const base = {
  ...process.env,
  GACHIPAD_COPY_FROM: `sqlite:${source}`,
  GACHIPAD_COPY_TO: `sqlite:${absent}`,
  GACHIPAD_PREFLIGHT_BUNDLED: "sqlite",
  GACHIPAD_PREFLIGHT_DATA_PATH: fixture,
};
const run = (env = {}, status = 0, expected = "preflight passed", bootstrap = "handles.mjs") => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsx, "--import", join(fixture, bootstrap), entry],
    { cwd: api, env: { ...base, ...env }, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined, "preflight must exit despite live handles");
  assert.equal(result.status, status, "preflight exit status");
  const log = result.stdout + result.stderr;
  assert.ok(log.includes(expected), "preflight diagnostic category");
  assert.ok(
    !/private@|[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(log),
    "preflight must not log secrets or URLs",
  );
  if (env.STALL)
    assert.equal(
      readFileSync(env.STALL_REACHED, "utf8"),
      env.STALL,
      "watchdog must interrupt the requested driver phase",
    );
  checks++;
};
const setup = (url) => {
  const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-"], {
    cwd: api,
    env: { ...process.env, FIXTURE_DATABASE: url },
    input:
      'import { openStores } from "@gachipad/storage"; const opened = await openStores(process.env.FIXTURE_DATABASE); await opened.close(); process.exit(0);',
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, "fixture schema creation");
};
const checkpoint = sql
  .split("<<'CHECKPOINT' || die ")[1]
  ?.split("\n")
  .slice(1)
  .join("\n")
  .split("\nCHECKPOINT\n")[0];
assert.ok(checkpoint, "production checkpoint heredoc must exist");
const checkpointEntry = join(fixture, "checkpoint.mjs");
writeFileSync(checkpointEntry, checkpoint);
const runCheckpoint = (path, status = 0) => {
  const result = spawnSync(process.execPath, [checkpointEntry], {
    env: { ...process.env, GACHIPAD_COPY_FROM: `sqlite:${path}` },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.error, undefined, "checkpoint must exit promptly");
  assert.equal(result.status, status, "checkpoint exit status");
  checks++;
  return result;
};
const digest = () => createHash("sha256").update(readFileSync(source)).digest("hex");
let pg;
const databases = [];
try {
  const dirty = join(fixture, "dirty.db");
  const crash = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('retained')");
    process.exit(0);
  `,
      dirty,
    ],
    { encoding: "utf8" },
  );
  assert.equal(crash.status, 0);
  assert.ok(readFileSync(`${dirty}-wal`).length > 0);
  const alias = join(fixture, "alias.db");
  symlinkSync(dirty, alias);
  runCheckpoint(alias);
  assert.throws(() => readFileSync(`${dirty}-wal`));
  assert.throws(() => readFileSync(`${dirty}-shm`));
  const recovered = new DatabaseSync(dirty, { readOnly: true });
  assert.equal(recovered.prepare("SELECT value FROM fixture").get().value, "retained");
  recovered.close();
  const clean = createHash("sha256").update(readFileSync(dirty)).digest("hex");
  runCheckpoint(dirty);
  assert.equal(createHash("sha256").update(readFileSync(dirty)).digest("hex"), clean);
  const live = new DatabaseSync(dirty);
  try {
    live.exec("PRAGMA journal_mode=WAL; INSERT INTO fixture VALUES ('still-open')");
    // A held read transaction forces wal_checkpoint to return busy, independently of sidecars.
    live.exec("BEGIN; SELECT * FROM fixture");
    const busy = runCheckpoint(dirty, 1);
    assert.match(busy.stderr, /checkpoint refused \(SQLITE_BUSY\)/);
    live.exec("ROLLBACK");
    runCheckpoint(dirty, 1);
    assert.ok(readFileSync(`${dirty}-shm`).length > 0, "open source sidecars must trigger refusal");
    assert.equal(live.prepare("SELECT count(*) AS total FROM fixture").get().total, 2);
  } finally {
    live.close();
  }
  runCheckpoint(dirty);
  runCheckpoint(absent, 1);
  assert.throws(() => readFileSync(absent));
  console.log(
    "ok: production SQLite checkpoint preserves crash WAL rows, removes sidecars, leaves clean sources unchanged and refuses open or missing sources",
  );
  setup(`sqlite:${source}`);
  const sqlite = new DatabaseSync(source);
  sqlite.exec("PRAGMA journal_mode=DELETE");
  sqlite.close();
  const before = digest();
  run();
  assert.equal(digest(), before, "successful preflight must preserve source bytes");
  run({ GACHIPAD_COPY_FROM: `sqlite:${absent}` }, 1, "preflight failed");
  assert.throws(() => readFileSync(absent), "missing source must not be created");
  run({ GACHIPAD_PREFLIGHT_DATA_PATH: join(fixture, "missing") }, 1, "ENOENT");
  assert.equal(digest(), before, "failed preflight must preserve source bytes");
  const schema = new DatabaseSync(source);
  assert.equal(schema.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  schema.exec("DELETE FROM schema_version");
  schema.close();
  run({}, 1, "SOURCE_SCHEMA");
  rmSync(source);
  setup(`sqlite:${source}`);
  run(
    {
      GACHIPAD_PREFLIGHT_BUNDLED: "external",
      GACHIPAD_COPY_TO: "postgresql://fixture:private@127.0.0.1:1/unreachable",
    },
    1,
    "preflight failed",
  );
  for (const stall of ["open", "query", "close"]) {
    run(
      {
        GACHIPAD_COPY_FROM: "mongodb://fixture:private@unreachable.invalid/source",
        STALL: stall,
        STALL_REACHED: join(fixture, `stalled-${stall}`),
      },
      1,
      "ETIMEDOUT",
      "watchdog.mjs",
    );
  }
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone verifier runs outside Turbo
  if (process.env.MIGRATE_PREFLIGHT_PG === "1") {
    // Read only connection metadata; never print container config or credentials.
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone verifier runs outside Turbo
    const container = process.env.MIGRATE_PREFLIGHT_PG_CONTAINER || "gp-sql-pg";
    const config = JSON.parse(
      execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
    )[0];
    const settings = Object.fromEntries(
      config.Config.Env.map((value) => {
        const index = value.indexOf("=");
        return [value.slice(0, index), value.slice(index + 1)];
      }),
    );
    const port = config.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort;
    assert.ok(port && settings.POSTGRES_PASSWORD && settings.POSTGRES_USER);
    const connection = new URL("postgresql://127.0.0.1");
    connection.port = port;
    connection.username = settings.POSTGRES_USER;
    connection.password = settings.POSTGRES_PASSWORD;
    connection.pathname = "/postgres";
    const { Client } = createRequire(require.resolve("@gachipad/storage"))("pg");
    pg = new Client({ connectionString: connection.href });
    await pg.connect();
    for (const suffix of ["source", "target"]) {
      const name = `gp_migrate_preflight_${process.pid}_${suffix}`;
      await pg.query(`CREATE DATABASE ${name}`);
      databases.push(name);
    }
    const sourceUrl = new URL(connection);
    sourceUrl.pathname = `/${databases[0]}`;
    const targetUrl = new URL(connection);
    targetUrl.pathname = `/${databases[1]}`;
    setup(sourceUrl.href);
    run({ GACHIPAD_COPY_FROM: sourceUrl.href });
    const target = new Client({ connectionString: targetUrl.href });
    await target.connect();
    try {
      run({ GACHIPAD_COPY_TO: targetUrl.href, GACHIPAD_PREFLIGHT_BUNDLED: "external" });
      assert.equal(
        (
          await target.query(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
          )
        ).rows[0].count,
        "0",
        "preflight must not initialize target schema",
      );
      await target.query(
        "CREATE TABLE settings (id text); INSERT INTO settings VALUES ('preflight-row')",
      );
      run(
        { GACHIPAD_COPY_TO: targetUrl.href, GACHIPAD_PREFLIGHT_BUNDLED: "external" },
        2,
        "Destination is not empty",
      );
      run(
        { GACHIPAD_COPY_TO: targetUrl.href, GACHIPAD_PREFLIGHT_BUNDLED: "external" },
        2,
        "Destination is not empty",
      );
      assert.equal(
        (await target.query("SELECT id FROM settings")).rows[0].id,
        "preflight-row",
        "refusal must preserve existing rows",
      );
    } finally {
      await target.end();
    }
    console.log(
      "ok: production preflight PostgreSQL source, empty destination, refusal and repeat refusal",
    );
  }
  console.log(
    `ok: production preflight ${checks} checks; SQLite stays read-only; live handles and pending opens/queries/closes cannot hang`,
  );
} finally {
  if (pg) {
    try {
      for (const name of databases) await pg.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await pg.end();
    }
  }
  rmSync(fixture, { recursive: true, force: true });
}
