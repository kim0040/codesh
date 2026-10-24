import type { Room } from "@codesh/shared";

/**
 * Network group resolution (§7): the room whose CIDR contains the client, else the IPv4 /24
 * (`subnetPrefixV4`) or IPv6 /64. The client IP is the socket address, unless the socket belongs to
 * a trusted proxy, in which case it comes from `X-Forwarded-For`.
 */

export interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

const IPV6_PREFIX = 64;

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIpv6(raw: string): Uint8Array | null {
  const text = raw.split("%")[0] ?? "";
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    const pieces = part.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        // An embedded IPv4 address is only valid as the last piece.
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push(((v4[0] as number) << 8) | (v4[1] as number));
        groups.push(((v4[2] as number) << 8) | (v4[3] as number));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(Number.parseInt(piece, 16));
      }
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (const [i, group] of groups.entries()) {
    out[i * 2] = group >> 8;
    out[i * 2 + 1] = group & 0xff;
  }
  return out;
}

const isMappedV4 = (b: Uint8Array) =>
  b.length === 16 && b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** 4 bytes for IPv4 (including IPv4-mapped IPv6), 16 bytes for IPv6, null when unparsable. */
export function parseIp(text: string): Uint8Array | null {
  const trimmed = text.trim();
  const bytes = trimmed.includes(":") ? parseIpv6(trimmed) : parseIpv4(trimmed);
  if (!bytes) return null;
  return isMappedV4(bytes) ? bytes.slice(12) : bytes;
}

export function formatIp(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
  // Compress the longest run of zero groups (at least two long).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (g: number) => g.toString(16);
  if (bestLen < 2) return groups.map(hex).join(":");
  const left = groups.slice(0, bestStart).map(hex).join(":");
  const right = groups
    .slice(bestStart + bestLen)
    .map(hex)
    .join(":");
  return `${left}::${right}`;
}

export function parseCidr(text: string): Cidr | null {
  const [address, length, extra] = text.trim().split("/");
  if (address === undefined || extra !== undefined) return null;
  const rawBytes = address.includes(":") ? parseIpv6(address) : parseIpv4(address);
  if (!rawBytes) return null;
  let bytes = rawBytes;
  let max = bytes.length * 8;
  if (length !== undefined && !/^[0-9]{1,3}$/.test(length)) return null;
  let prefix = length === undefined ? max : Number(length);
  if (isMappedV4(rawBytes)) {
    // ::ffff:10.0.0.0/104 is the IPv4 network 10.0.0.0/8.
    bytes = rawBytes.slice(12);
    max = 32;
    prefix = length === undefined ? 32 : prefix - 96;
  }
  if (prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

export const isValidCidr = (text: string) => parseCidr(text) !== null;

function mask(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = (bytes[i] as number) & (bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff);
  }
  return out;
}

export function cidrContains(cidr: Cidr, ip: Uint8Array): boolean {
  if (cidr.bytes.length !== ip.length) return false;
  const a = mask(cidr.bytes, cidr.prefix);
  const b = mask(ip, cidr.prefix);
  return a.every((x, i) => x === b[i]);
}

export function parseCidrs(list: readonly string[]): Cidr[] {
  return list.flatMap((entry) => {
    const cidr = parseCidr(entry);
    return cidr ? [cidr] : [];
  });
}

const isTrusted = (ip: Uint8Array, trusted: readonly Cidr[]) =>
  trusted.some((cidr) => cidrContains(cidr, ip));

/**
 * The client address. `X-Forwarded-For` is only read when the socket peer is a trusted proxy, and
 * then it is walked from the right: the first entry that is not itself a trusted proxy is the
 * client. Anything the client prepended further left is ignored, so it cannot be spoofed.
 */
export function resolveClientIp(
  socketIp: string,
  forwardedFor: string | undefined,
  trusted: readonly Cidr[],
): string {
  const socket = parseIp(socketIp);
  if (!socket) return socketIp;
  if (!forwardedFor || !isTrusted(socket, trusted)) return formatIp(socket);

  const entries = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = parseIp(entries[i] as string);
    // A malformed hop means the chain cannot be trusted past this point.
    if (!ip) return formatIp(socket);
    if (!isTrusted(ip, trusted) || i === 0) return formatIp(ip);
  }
  return formatIp(socket);
}

export interface NetGroup {
  net: string;
  room: string | null;
}

export interface NetSettings {
  rooms: readonly Room[];
  subnetPrefixV4: number;
}

const roomCache = new WeakMap<readonly Room[], { name: string; cidrs: Cidr[] }[]>();

function parsedRooms(rooms: readonly Room[]) {
  let parsed = roomCache.get(rooms);
  if (!parsed) {
    parsed = rooms.map((room) => ({ name: room.name, cidrs: parseCidrs(room.cidrs) }));
    roomCache.set(rooms, parsed);
  }
  return parsed;
}

export function resolveNet(ip: string, settings: NetSettings): NetGroup {
  const bytes = parseIp(ip);
  if (!bytes) return { net: "unknown", room: null };
  for (const room of parsedRooms(settings.rooms)) {
    if (room.cidrs.some((cidr) => cidrContains(cidr, bytes))) {
      return { net: room.name, room: room.name };
    }
  }
  const prefix = bytes.length === 4 ? settings.subnetPrefixV4 : IPV6_PREFIX;
  return { net: `${formatIp(mask(bytes, prefix))}/${prefix}`, room: null };
}

/** Abuse limits use one IPv4 address or one IPv6 /64, independent of display rooms. */
export function networkKey(ip: string): string {
  const bytes = parseIp(ip);
  if (!bytes) return "unknown";
  return bytes.length === 16 ? `${formatIp(mask(bytes, 64))}/64` : formatIp(bytes);
}
