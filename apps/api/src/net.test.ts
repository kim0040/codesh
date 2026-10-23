import { describe, expect, it } from "vitest";
import {
  cidrContains,
  formatIp,
  isValidCidr,
  parseCidr,
  parseCidrs,
  parseIp,
  resolveClientIp,
  resolveNet,
} from "./net.js";

const settings = (rooms: { name: string; cidrs: string[] }[] = [], subnetPrefixV4 = 24) => ({
  rooms,
  subnetPrefixV4,
});

describe("parseIp / formatIp", () => {
  it("parses IPv4 and rejects malformed addresses", () => {
    expect(formatIp(parseIp("192.168.1.20") as Uint8Array)).toBe("192.168.1.20");
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "a.b.c.d", "1.2.3.-4"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it("parses IPv6 including :: and embedded IPv4, and normalises the text", () => {
    expect(formatIp(parseIp("2001:DB8:0:0:0:0:0:1") as Uint8Array)).toBe("2001:db8::1");
    expect(formatIp(parseIp("::1") as Uint8Array)).toBe("::1");
    expect(formatIp(parseIp("fe80::1%eth0") as Uint8Array)).toBe("fe80::1");
    for (const bad of ["1::2::3", "12345::", "1:2:3:4:5:6:7", "::g", "1:2:3:4:5:6:7:8:9"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it("treats IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(formatIp(parseIp("::ffff:10.1.2.3") as Uint8Array)).toBe("10.1.2.3");
    expect(formatIp(parseIp("::ffff:a01:203") as Uint8Array)).toBe("10.1.2.3");
  });
});

describe("CIDR matching", () => {
  const contains = (cidr: string, ip: string) =>
    cidrContains(
      parseCidr(cidr) as NonNullable<ReturnType<typeof parseCidr>>,
      parseIp(ip) as Uint8Array,
    );

  it("matches by prefix length, including non-octet boundaries", () => {
    expect(contains("10.0.0.0/8", "10.255.1.1")).toBe(true);
    expect(contains("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(contains("192.168.4.0/22", "192.168.7.200")).toBe(true);
    expect(contains("192.168.4.0/22", "192.168.8.1")).toBe(false);
    expect(contains("203.0.113.9", "203.0.113.9")).toBe(true);
    expect(contains("203.0.113.9", "203.0.113.10")).toBe(false);
    expect(contains("0.0.0.0/0", "8.8.8.8")).toBe(true);
  });

  it("matches IPv6 and never mixes families", () => {
    expect(contains("fd00:1234::/32", "fd00:1234:ffff::5")).toBe(true);
    expect(contains("fd00:1234::/32", "fd00:1235::5")).toBe(false);
    expect(contains("fd00::/8", "10.0.0.1")).toBe(false);
    expect(contains("::ffff:10.0.0.0/104", "10.9.9.9")).toBe(true);
  });

  it("rejects invalid CIDRs and skips them in lists", () => {
    for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0/8", "x/8", "10.0.0.0/8/8", "::/129"]) {
      expect(isValidCidr(bad), bad).toBe(false);
    }
    expect(parseCidrs(["10.0.0.0/8", "nope", "fd00::/8"])).toHaveLength(2);
  });
});

describe("resolveClientIp", () => {
  const trusted = parseCidrs(["10.0.0.0/8", "172.16.0.0/12"]);

  it("uses the socket address when the peer is not a trusted proxy", () => {
    expect(resolveClientIp("203.0.113.7", "1.2.3.4", trusted)).toBe("203.0.113.7");
    expect(resolveClientIp("203.0.113.7", "1.2.3.4", [])).toBe("203.0.113.7");
  });

  it("reads X-Forwarded-For when the peer is trusted", () => {
    expect(resolveClientIp("10.0.0.2", "198.51.100.9", trusted)).toBe("198.51.100.9");
  });

  it("walks the chain from the right so a spoofed left entry is ignored", () => {
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 198.51.100.9, 172.16.0.5", trusted)).toBe(
      "198.51.100.9",
    );
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 10.1.1.1", trusted)).toBe("6.6.6.6");
  });

  it("falls back to the peer when the header is empty or malformed", () => {
    expect(resolveClientIp("10.0.0.2", undefined, trusted)).toBe("10.0.0.2");
    expect(resolveClientIp("10.0.0.2", "", trusted)).toBe("10.0.0.2");
    expect(resolveClientIp("10.0.0.2", "garbage, 10.1.1.1", trusted)).toBe("10.0.0.2");
  });

  it("normalises IPv4-mapped socket addresses", () => {
    expect(resolveClientIp("::ffff:10.0.0.2", "198.51.100.9", trusted)).toBe("198.51.100.9");
    expect(resolveClientIp("::ffff:203.0.113.7", undefined, trusted)).toBe("203.0.113.7");
  });
});

describe("resolveNet", () => {
  it("groups IPv4 clients by /24 by default", () => {
    expect(resolveNet("192.168.5.77", settings())).toEqual({ net: "192.168.5.0/24", room: null });
    expect(resolveNet("192.168.5.200", settings()).net).toBe(
      resolveNet("192.168.5.1", settings()).net,
    );
    expect(resolveNet("192.168.6.1", settings()).net).not.toBe(
      resolveNet("192.168.5.1", settings()).net,
    );
  });

  it("honours subnetPrefixV4", () => {
    expect(resolveNet("10.20.77.9", settings([], 16))).toEqual({ net: "10.20.0.0/16", room: null });
    expect(resolveNet("10.20.77.9", settings([], 22)).net).toBe("10.20.76.0/22");
  });

  it("groups IPv6 clients by /64", () => {
    expect(resolveNet("2001:db8:1:2:aaaa:bbbb:cccc:dddd", settings())).toEqual({
      net: "2001:db8:1:2::/64",
      room: null,
    });
  });

  it("puts clients in the first room whose CIDR contains them", () => {
    const rooms = [
      { name: "Lab A", cidrs: ["10.1.0.0/16", "10.9.9.0/24"] },
      { name: "Lab B", cidrs: ["10.1.2.0/24"] },
    ];
    expect(resolveNet("10.1.2.3", settings(rooms))).toEqual({ net: "Lab A", room: "Lab A" });
    expect(resolveNet("10.9.9.9", settings(rooms))).toEqual({ net: "Lab A", room: "Lab A" });
    expect(resolveNet("10.2.0.1", settings(rooms))).toEqual({ net: "10.2.0.0/24", room: null });
  });

  it("uses one group for an unparsable address instead of throwing", () => {
    expect(resolveNet("not-an-ip", settings())).toEqual({ net: "unknown", room: null });
  });
});
