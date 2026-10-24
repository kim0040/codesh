// Run on the dev box against the disposable security compose project after browser verification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("apps/web/package.json"));
const { request } = require("@playwright/test");
const root = process.cwd();
const stage = `${root}/.box-out/security-deploy`;
for (const name of ["backup.sh", "restore.sh", "lib.sh"])
  copyFileSync(`${root}/deploy/${name}`, `${stage}/${name}`);
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: "codesh-security-edge",
  COMPOSE_FILE: `${root}/deploy/docker-compose.yml`,
  COMPOSE_ENV_FILES: `${root}/.box-out/security-deploy/.env`,
};
const docker = (...args) =>
  execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const api = await request.newContext({
  baseURL: "http://127.0.0.1:18180",
  extraHTTPHeaders: { "X-Codesh": "1" },
});
try {
  assert.equal((await api.get("/metrics/api")).status(), 200);
  assert.equal((await api.get("/metrics/collab")).status(), 200);
  assert.equal((await api.get("/metrics")).status(), 403);
  const untrustedNet = "codesh-security-untrusted";
  const edge = docker("compose", "ps", "-q", "caddy").trim();
  docker("network", "create", "--subnet", "172.29.92.0/24", untrustedNet);
  try {
    docker("network", "connect", untrustedNet, edge);
    const address = docker(
      "inspect",
      "-f",
      '{{ (index .NetworkSettings.Networks "codesh-security-untrusted").IPAddress }}',
      edge,
    ).trim();
    const outside = docker(
      "run",
      "--rm",
      "--network",
      untrustedNet,
      "--entrypoint",
      "node",
      "codesh/api:security-test",
      "-e",
      `fetch("http://${address}/metrics/api", {headers:{"X-Forwarded-For":"127.0.0.1"}}).then(r=>{if(r.status!==403)throw Error(String(r.status));console.log("403")})`,
    );
    assert.equal(outside.trim(), "403");
  } finally {
    docker("network", "disconnect", untrustedNet, edge);
    docker("network", "rm", untrustedNet);
  }
  const database = docker(
    "compose",
    "exec",
    "-T",
    "api",
    "node",
    "--input-type=module",
    "-e",
    'import{MongoClient}from"mongodb";const c=await MongoClient.connect(process.env.MONGO_URL);try{await c.db("codesh").collection("security_probe").insertOne({ok:true});await c.db("codesh").collection("security_probe").deleteMany({});let denied=false;try{await c.db("admin").command({serverStatus:1})}catch(e){denied=e.code===13}if(!denied)throw Error("application has admin privileges");console.log("readWrite-only")}finally{await c.close()}',
  );
  assert.equal(database.trim(), "readWrite-only");
  const backup = execFileSync("bash", [`${stage}/backup.sh`, `${root}/.box-out/security-backups`], {
    env,
    encoding: "utf8",
  });
  const path = /backup: (.+) \(/.exec(backup)?.[1];
  assert(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(`${root}/.box-out/security-backups`).mode & 0o777, 0o700);
  execFileSync("bash", [`${stage}/restore.sh`, path, "--yes"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const created = await api.post("/api/shares", { data: {} });
  assert.equal(created.status(), 200);
  const { id } = await created.json();
  try {
    assert.equal(
      docker(
        "compose",
        "exec",
        "-T",
        "valkey",
        "sh",
        "-ec",
        'export REDISCLI_AUTH="$VALKEY_PASSWORD"; valkey-cli config set maxmemory 1',
      ).trim(),
      "OK",
    );
    // Admission caches the memory sample for at most one second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await api.get("/healthz")).status(), 200);
    assert.equal((await api.get("/api/session")).status(), 200);
    assert.equal((await api.get(`/api/shares/${id}`)).status(), 200);
    assert.equal((await api.post("/api/shares", { data: {} })).status(), 503);
    assert.equal((await api.patch(`/api/shares/${id}`, { data: { locked: true } })).status(), 200);
  } finally {
    docker(
      "compose",
      "exec",
      "-T",
      "valkey",
      "sh",
      "-ec",
      'export REDISCLI_AUTH="$VALKEY_PASSWORD"; valkey-cli config set maxmemory 1gb',
    );
  }
  console.log("L9: metrics allowed on loopback, denied outside compose despite forged XFF");
  console.log(
    "L10: application readWrite-only; backup 0600/directory 0700; real backup and restore passed",
  );
  console.log(
    "M3: Valkey noeviction OOM preserves health/session/share reads, rejects creation with 503, permits lock changes",
  );
} finally {
  await api.dispose();
}
