// Advertises the codesh host name on the LAN with multicast DNS, so people can open
// http://codesh.local (docs/PLAN.md 2.4). A sidecar: apps/api stays untouched.
//
//   MDNS_HOSTNAME  name to answer for (default codesh.local)
//   MDNS_PORT      port of the web server (default 80)
//   MDNS_IP        advertise this IPv4 address instead of every non-loopback one of the host
import { Bonjour } from "bonjour-service";

const host = process.env.MDNS_HOSTNAME || "codesh.local";
const port = Number(process.env.MDNS_PORT || 80);
const ip = process.env.MDNS_IP || "";

if (!host.endsWith(".local")) {
  console.error(`mdns: MDNS_HOSTNAME must end in .local, got "${host}"`);
  process.exit(1);
}

const bonjour = new Bonjour();
const service = bonjour.publish({
  name: "codesh",
  type: "http",
  port,
  host,
  txt: { path: "/" },
  disableIPv6: true,
});

if (ip) {
  // Replace the address records bonjour-service derives from the host's interfaces.
  const records = service.records.bind(service);
  service.records = () => [
    ...records().filter((record) => record.type !== "A" && record.type !== "AAAA"),
    { name: host, type: "A", ttl: 120, data: ip },
  ];
}

service.on("up", () => console.log(`mdns: advertising ${host} (port ${port}${ip ? `, ${ip}` : ""})`));
service.on("error", (error) => console.error("mdns:", error));

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
