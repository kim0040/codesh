import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateShareId } from "@gachipad/shared";
import { MONGO_TEST_URL, VALKEY_TEST_URL } from "@gachipad/storage/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Harness,
  servicesAvailable,
  sleep,
  storedText,
  TEST_SECRET,
  waitFor,
} from "./testing/harness.js";

const available = await servicesAvailable();
const appDir = fileURLToPath(new URL("..", import.meta.url));

interface Spawned {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

/** Runs src/main.ts in its own process, as in production. */
async function spawnServer(dbName: string, instanceId: string): Promise<Spawned> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: "testing",
      HOST: "127.0.0.1",
      PORT: "0",
      MONGO_URL: `${MONGO_TEST_URL}/${dbName}`,
      VALKEY_URL: VALKEY_TEST_URL,
      COLLAB_SECRET: TEST_SECRET,
      COLLAB_INSTANCE_ID: instanceId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (ws:\/\/\S+)\/collab/.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    void exited.then((code) => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
  return { child, url, exited };
}

const tokens = (text: string) => new Set([...text.matchAll(/<(\d+)>/g)].map((m) => Number(m[1])));

describe.runIf(available)("crash and restart", () => {
  let harness: Harness;
  const running: Spawned[] = [];

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(async () => {
    for (const s of running) s.child.kill("SIGKILL");
    await harness?.close();
  });

  it("loses at most the last second of typing when killed, and nothing on SIGTERM", async () => {
    const share = await harness.createShare();
    const dbName = harness.database.db.databaseName;
    const instanceId = `crash-${generateShareId()}`;

    const first = await spawnServer(dbName, instanceId);
    running.push(first);
    const writer = await harness.connect(first.url, share.id);
    await writer.synced;

    const typed: Array<{ n: number; at: number }> = [];
    const typing = setInterval(() => {
      const n = typed.length;
      writer.text.insert(writer.text.length, `<${n}>`);
      typed.push({ n, at: Date.now() });
    }, 5);
    await sleep(1500);
    // No graceful shutdown: the process dies mid-typing with whatever is still buffered.
    first.child.kill("SIGKILL");
    const killedAt = Date.now();
    clearInterval(typing);
    writer.destroy();
    await first.exited;

    const second = await spawnServer(dbName, instanceId);
    running.push(second);
    const reader = await harness.connect(second.url, share.id);
    await reader.synced;
    const present = tokens(reader.text.toString());
    const lost = typed.filter((t) => !present.has(t.n));
    const windowMs = lost.length === 0 ? 0 : killedAt - Math.min(...lost.map((t) => t.at));
    console.log(
      `[measure] crash: typed ${typed.length} updates, lost ${lost.length}, oldest lost ${windowMs} ms before the kill`,
    );
    expect(present.size).toBeGreaterThan(0);
    expect(windowMs).toBeLessThanOrEqual(1000);
    // What survived is a prefix of what was typed.
    expect([...present].every((n) => n < typed.length - lost.length)).toBe(true);

    // Graceful stop: everything typed before SIGTERM is stored and compacted.
    const before = reader.text.length;
    for (let i = 0; i < 20; i++) reader.text.insert(reader.text.length, `[t${i}]`);
    await waitFor(() => reader.provider.unsyncedChanges === 0, "server acknowledged edits");
    const expected = reader.text.toString();
    expect(expected.length).toBeGreaterThan(before);
    reader.destroy();
    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(0);
    expect(await storedText(harness.stores, share.id)).toBe(expected);
    expect(await harness.stores.updates.read(share.id, 0)).toEqual([]);
  }, 60_000);
});
