import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe.skipIf(!integration)("join codes", () => {
  let forced: string[] = [];
  let h: Harness;
  beforeAll(async () => {
    // Codes come from the queue first, then at random, so a test can force a collision.
    h = await createHarness({
      randomCode: () => forced.shift() ?? String(100_000 + Math.floor(Math.random() * 900_000)),
    });
  });
  afterAll(() => h.close());

  it("GET /api/codes/:code resolves a share code to its id", async () => {
    const owner = h.client();
    const { id, code } = await createShare(owner);
    const response = await h.client().get(`/api/codes/${code}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id });
  });

  it("answers 404 for an unknown code and 400 for a malformed one", async () => {
    const client = h.client();
    const unknown = await client.get("/api/codes/999999");
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
    for (const bad of ["012345", "12345", "1234567", "abcdef"]) {
      const response = await client.get(`/api/codes/${bad}`);
      expect(response.statusCode, bad).toBe(400);
      expect(errorCode(response)).toBe("validation");
    }
  });

  it("gives two shares different codes when the generator collides (SET NX)", async () => {
    forced = ["424242", "424242", "424242", "535353"];
    const first = await createShare(h.client());
    const second = await createShare(h.client());
    expect(first.code).toBe("424242");
    expect(second.code).toBe("535353");
    expect(await h.valkey.get("code:424242")).toBe(first.id);
    expect(await h.valkey.get("code:535353")).toBe(second.id);
    const resolved = await h.client().get("/api/codes/424242");
    expect(resolved.json()).toEqual({ id: first.id });
  });

  it("does not hand a released code to a new share for 24 hours", async () => {
    forced = ["616161"];
    const owner = h.client();
    const first = await createShare(owner);
    expect(first.code).toBe("616161");
    await owner.delete(`/api/shares/${first.id}`);
    expect(await h.valkey.get("code:616161")).toBeNull();
    const cooldown = await h.valkey.ttl("code:cool:616161");
    expect(cooldown).toBeGreaterThan(86_000);
    expect(cooldown).toBeLessThanOrEqual(86_400);

    // The generator offers the cooling code again; it must be skipped.
    forced = ["616161", "717171"];
    const second = await createShare(h.client());
    expect(second.code).toBe("717171");
    expect((await h.client().get("/api/codes/616161")).statusCode).toBe(404);

    // Once the cooldown is over the code can be used again.
    await h.valkey.del("code:cool:616161");
    forced = ["616161"];
    const third = await createShare(h.client());
    expect(third.code).toBe("616161");
  });

  it("also keeps a code that merely expired from being reused right away", async () => {
    forced = ["818181"];
    const { id } = await createShare(h.client());
    await h.valkey.del("code:818181"); // as if its TTL ran out
    forced = ["818181", "828282"];
    const next = await createShare(h.client());
    expect(next.code).toBe("828282");
    expect(await h.stores.shares.get(id)).not.toBeNull();
  });

  it("keeps a join code alive while the share is joined, and never past the share", async () => {
    const owner = h.client();
    const { id, code } = await createShare(owner);
    await h.valkey.expire(`code:${code}`, 120);
    await h.client().post(`/api/shares/${id}/join`);
    const ttl = await h.valkey.ttl(`code:${code}`);
    expect(ttl).toBeGreaterThan(80_000);
  });

  it("answers 404 for a code whose share is gone, and 410 when it expired", async () => {
    const owner = h.client();
    const gone = await createShare(owner);
    await h.stores.shares.delete(gone.id);
    expect((await h.client().get(`/api/codes/${gone.code}`)).statusCode).toBe(404);

    const old = await createShare(owner);
    await h.stores.shares.update(old.id, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await h.client().get(`/api/codes/${old.code}`);
    expect(expired.statusCode).toBe(410);
    expect(errorCode(expired)).toBe("expired");
  });

  it("keeps the code of a live share when the lookup fails for another reason", async () => {
    const { id, code } = await createShare(h.client());
    const shares = h.stores.shares;
    const original = shares.get.bind(shares);
    shares.get = async () => {
      throw new Error("mongo timeout");
    };
    try {
      expect((await h.client().get(`/api/codes/${code}`)).statusCode).toBe(500);
    } finally {
      shares.get = original;
    }
    expect(await h.valkey.get(`code:${code}`)).toBe(id);
    expect((await h.client().get(`/api/codes/${code}`)).json()).toEqual({ id });
  });

  it("limits code lookups per IP so the code space cannot be scanned", async () => {
    const limited = await createHarness({
      config: {
        rateLimit: {
          apiPerMinute: 1000,
          codePerMinute: 3,
          createPerMinute: 100,
          loginPerMinute: 100,
        },
      },
    });
    try {
      const client = limited.client();
      for (let i = 0; i < 3; i++)
        expect((await client.get("/api/codes/999999")).statusCode).toBe(404);
      const blocked = await client.get("/api/codes/999999");
      expect(blocked.statusCode).toBe(429);
      expect(errorCode(blocked)).toBe("rate_limited");
      expect(await limited.valkey.get(`rl:${client.ip}:code`)).toBe("4");
    } finally {
      await limited.close();
    }
  });
});
