import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import multicastDns from "multicast-dns";

async function probe(answer, { malformed = false, name } = {}) {
  name ||= `gp-probe-${process.pid}-${Math.random().toString(16).slice(2)}.local`;
  const responder = multicastDns();
  responder.on("error", () => {});
  responder.on("warning", () => {});
  responder.on("query", (packet) => {
    if (!packet.questions.some((question) => question.name === name)) return;
    if (malformed) {
      const socket = dgram.createSocket("udp4");
      socket.send(Buffer.from([255, 0, 1]), 5353, "224.0.0.251", () => socket.close());
    }
    if (answer) {
      setTimeout(
        () => responder.respond({ answers: [{ name, type: "A", ttl: 120, ...answer }] }),
        50,
      );
    }
  });
  const child = spawn(process.execPath, ["index.mjs", "--probe", name], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.notEqual(code, null, output);
    return code;
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => responder.destroy(resolve));
  }
}

test("foreign address returns conflict exit 10 despite malformed unrelated traffic", async () => {
  assert.equal(await probe({ data: "192.0.2.254" }, { malformed: true }), 10);
});
test("own interface address returns exit 0", async () => {
  const own = Object.entries(networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr)/.test(name))
    .flatMap(([, entries]) => entries || [])
    .find((entry) => !entry.internal && entry.family === "IPv4");
  assert.ok(own);
  assert.equal(await probe({ data: own.address }), 0);
});
test("silence returns exit 0", async () => {
  assert.equal(await probe(), 0);
});
test("goodbye records do not cause conflicts", async () => {
  assert.equal(await probe({ data: "192.0.2.254", ttl: 0 }), 0);
});
test("invalid probe input returns exit 2", async () => {
  assert.equal(await probe(undefined, { name: "invalid.example" }), 2);
});
