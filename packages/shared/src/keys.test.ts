import { describe, expect, it } from "vitest";
import { formatSseEvent, sseEventSchema } from "./events.js";
import { channels, keys } from "./keys.js";

describe("valkey keys", () => {
  it("match ARCHITECTURE §7", () => {
    expect(keys.code("123456")).toBe("code:123456");
    expect(keys.codeCooldown("123456")).toBe("code:cool:123456");
    expect(keys.labCode("123456")).toBe("labcode:123456");
    expect(keys.presenceNet("10.0.1")).toBe("presence:10.0.1");
    expect(keys.presenceUser("u1")).toBe("presence:user:u1");
    expect(keys.nearbyNet("room-a")).toBe("nearby:room-a");
    expect(keys.nearbyItem("abc12345")).toBe("nearby:item:abc12345");
    expect(keys.pending("abc12345")).toBe("pending:abc12345");
    expect(keys.docLock("abc12345")).toBe("doclock:abc12345");
    expect(keys.sweeperLock).toBe("lock:sweeper");
    expect(keys.rateLimit("10.0.0.1", "pin")).toBe("rl:10.0.0.1:pin");
    expect(channels.perm("abc12345")).toBe("perm:abc12345");
    expect(channels.cmd("abc12345")).toBe("cmd:abc12345");
    expect(channels.cmdReply("r1")).toBe("cmd-reply:r1");
    expect(channels.user("u1")).toBe("user:u1");
    expect(channels.net("10.0.1")).toBe("net:10.0.1");
  });
});

describe("sse events", () => {
  it("formats the wire message", () => {
    const event = { event: "kicked", data: { shareId: "abcd1234", banned: true } } as const;
    expect(sseEventSchema.parse(event)).toEqual(event);
    expect(formatSseEvent(event)).toBe(
      'event: kicked\ndata: {"shareId":"abcd1234","banned":true}\n\n',
    );
  });
});
