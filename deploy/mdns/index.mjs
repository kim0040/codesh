// Advertises the gachipad host name on the LAN with multicast DNS, so people can open
// http://gachipad.local. A sidecar: apps/api stays untouched.
//
//   MDNS_HOSTNAME  name to answer for (default gachipad.local)
//   MDNS_PORT      port of the web server (default 80)
//   MDNS_IP        advertise this IPv4 address instead of every non-loopback one of the host

import { networkInterfaces } from "node:os";
import { Bonjour } from "bonjour-service";
import multicastDns from "multicast-dns";

const addresses = Object.entries(networkInterfaces())
  .filter(([name]) => !/^(docker|br-|veth|virbr)/.test(name))
  .flatMap(([, entries]) => entries || [])
  .filter((entry) => entry && !entry.internal);
// Exit 10 for a conflicting answer, 0 for silence/our own addresses, 2 for probe errors.
// --query also counts this host's answers, for an independent live verification.
if (["--probe", "--query"].includes(process.argv[2])) {
  const name = process.argv[3];
  if (!validName(name) || !addresses.some((entry) => entry.family === "IPv4")) process.exit(2);
  const own = new Set(
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries || []).map((entry) => entry.address),
    ),
  );
  if (process.env.MDNS_IP) own.add(process.env.MDNS_IP);
  const dns = multicastDns();
  let finished = false;
  let sent = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    dns.destroy(() => process.exit(code));
    setTimeout(() => process.exit(code), 100).unref();
  };
  dns.on("error", () => finish(2));
  dns.on("warning", () => {}); // Unrelated malformed packets do not invalidate our query.
  dns.on("response", (packet) => {
    for (const record of [...(packet.answers || []), ...(packet.additionals || [])]) {
      if (
        record.name.toLowerCase() === name.toLowerCase() &&
        record.ttl > 0 &&
        ["A", "AAAA"].includes(record.type) &&
        (process.argv[2] === "--query" || !own.has(record.data))
      )
        finish(10);
    }
  });
  const query = () =>
    dns.query(
      [
        { name, type: "A" },
        { name, type: "AAAA" },
      ],
      (error) => {
        if (error) finish(2);
        else sent = true;
      },
    );
  query();
  setTimeout(query, 400).unref();
  setTimeout(query, 800).unref();
  setTimeout(() => finish(sent ? 0 : 2), 1400);
  // Do not fall through to publication while the probe is listening.
  await new Promise(() => {});
}

function validName(name) {
  return (
    typeof name === "string" &&
    /^(?=.{1,63}\.local$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.local$/i.test(name)
  );
}

const host = process.env.MDNS_HOSTNAME || "gachipad.local";
const hosts = [...new Set([host, ...(process.env.MDNS_ALIASES || "").split(",").filter(Boolean)])];
const port = Number(process.env.MDNS_PORT || 80);
const ip = process.env.MDNS_IP || "";

const invalid = hosts.find((name) => !validName(name));
if (invalid !== undefined) {
  console.error("mdns: MDNS_HOSTNAME and MDNS_ALIASES must be single-label .local host names");
  process.exit(1);
}

const bonjour = new Bonjour();
for (const host of hosts) {
  const service = bonjour.publish({
    name: `gachipad (${host.slice(0, -6)})`,
    type: "http",
    port,
    host,
    txt: { path: "/" },
    disableIPv6: true,
  });

  // Exclude virtual bridge addresses from publication; probes still recognize every own address.
  const records = service.records.bind(service);
  service.records = () => [
    ...records().filter((record) => record.type !== "A" && record.type !== "AAAA"),
    ...(ip
      ? [ip]
      : addresses.filter((entry) => entry.family === "IPv4").map((entry) => entry.address)
    ).map((address) => ({ name: host, type: "A", ttl: 120, data: address })),
  ];

  service.on("up", () =>
    console.log(`mdns: advertising ${host} (port ${port}${ip ? `, ${ip}` : ""})`),
  );
  service.on("error", (error) => console.error("mdns:", error));
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  bonjour.unpublishAll(() => {
    bonjour.destroy();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
