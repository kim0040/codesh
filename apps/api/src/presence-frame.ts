import { createHash } from "node:crypto";
import type { PresenceUser } from "@codesh/shared";

const HEAD = Buffer.from("event: presence\ndata: [");
const TAIL = Buffer.from("]\n\n");
const COMMA = Buffer.from(",");
interface Entry {
  start: number;
  end: number;
  hash: bigint;
}
export interface PresenceFrame {
  fingerprint(clientId: string): string;
  chunks(clientId: string): Buffer[];
}
const cache = new WeakMap<PresenceUser[], PresenceFrame>();

/** One encoding per network snapshot. Each stream omits itself with constant-size buffer views. */
export function presenceFrame(users: PresenceUser[]): PresenceFrame {
  const cached = cache.get(users);
  if (cached) return cached;
  const entries = new Map<string, Entry>();
  const parts: Buffer[] = [];
  let offset = 0;
  let hash = 0n;
  for (const user of users) {
    if (parts.length) {
      parts.push(COMMA);
      offset++;
    }
    const part = Buffer.from(JSON.stringify(user));
    const ownHash = BigInt(`0x${createHash("sha256").update(part).digest("hex")}`);
    entries.set(user.clientId, { start: offset, end: offset + part.length, hash: ownHash });
    parts.push(part);
    offset += part.length;
    hash ^= ownHash;
  }
  const body = Buffer.concat(parts);
  const frame: PresenceFrame = {
    // Sorting is determined by the fields in each entry. XOR permits exclusion without hashing
    // the whole list per recipient; only change detection uses it, never authorization.
    fingerprint(clientId) {
      const mine = entries.get(clientId);
      return `${users.length - (mine ? 1 : 0)}:${(hash ^ (mine?.hash ?? 0n)).toString(16)}`;
    },
    chunks(clientId) {
      const mine = entries.get(clientId);
      if (!mine) return [HEAD, body, TAIL];
      const from = mine.start > 0 ? mine.start - 1 : 0;
      const to = mine.start === 0 && mine.end < body.length ? mine.end + 1 : mine.end;
      return [HEAD, body.subarray(0, from), body.subarray(to), TAIL];
    },
  };
  cache.set(users, frame);
  return frame;
}
