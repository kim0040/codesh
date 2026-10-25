// Advertises the gachipad host name on the LAN with multicast DNS, so people can open
// http://gachipad.local. A sidecar: apps/api stays untouched.
//
//   MDNS_HOSTNAME  name to answer for (default gachipad.local)
//   MDNS_PORT      port of the web server (default 80)
//   MDNS_IP        advertise this IPv4 address instead of every non-loopback one of the host
import { Bonjour } from "bonjour-service";

const host = process.env.MDNS_HOSTNAME || "gachipad.local";
const hosts = [...new Set([host, ...(process.env.MDNS_ALIASES || "").split(",").filter(Boolean)])];
const port = Number(process.env.MDNS_PORT || 80);
const ip = process.env.MDNS_IP || "";

const invalid = hosts.find((name) => !name.endsWith(".local"));
if (invalid !== undefined) {
  console.error(`mdns: MDNS_HOSTNAME and MDNS_ALIASES must end in .local, got "${invalid}"`);
  process.exit(1);
}

const bonjour = new Bonjour();
for (const host of hosts) {
  const service = bonjour.publish({
    name: host === hosts[0] ? "gachipad" : `gachipad (${host})`,
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
