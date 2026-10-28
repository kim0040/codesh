import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import multicastDns from "multicast-dns";

// Preload that makes os.networkInterfaces() report the given interfaces.
const fakeInterfaces = (interfaces) => [
  "--import",
  `data:text/javascript,${encodeURIComponent(
    `import{syncBuiltinESMExports}from"node:module";import os from"node:os";os.networkInterfaces=()=>(${JSON.stringify(interfaces)});syncBuiltinESMExports();`,
  )}`,
];
const ipv4 = (address) => [{ address, family: "IPv4", internal: false }];

async function probe(answer, { malformed = false, name, interfaces } = {}) {
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
  const child = spawn(
    process.execPath,
    [...(interfaces ? fakeInterfaces(interfaces) : []), "index.mjs", "--probe", name],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    .filter(([name]) => !/^(docker|veth|virbr|br-[0-9a-f]{12}$)/.test(name))
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
test("a user bridge such as br-lan counts as an interface, docker's br-<12 hex> does not", async () => {
  assert.equal(await probe(undefined, { interfaces: { "br-lan": ipv4("192.0.2.30") } }), 0);
  assert.equal(
    await probe(undefined, { interfaces: { "br-0123456789ab": ipv4("172.29.1.1") } }),
    2,
  );
});

// The sidecar publishes until stopped; resolves with its exit code, or null when it kept running.
async function sidecar(interfaces, env = {}) {
  const child = spawn(process.execPath, [...fakeInterfaces(interfaces), "index.mjs"], {
    env: { ...process.env, MDNS_HOSTNAME: `gp-side-${process.pid}.local`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  if (code === undefined) {
    child.kill("SIGTERM");
    await exited;
    return { code: null, output };
  }
  return { code, output };
}
test("sidecar exits 1 with a clear message when no usable IPv4 address exists", async () => {
  const result = await sidecar({ "br-0123456789ab": ipv4("172.29.1.1") });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /no usable IPv4 address.*MDNS_IP/);
});
test("sidecar keeps running without a usable interface when MDNS_IP is set", async () => {
  const result = await sidecar(
    { "br-0123456789ab": ipv4("172.29.1.1") },
    { MDNS_IP: "192.0.2.30" },
  );
  assert.equal(result.code, null, result.output);
});
