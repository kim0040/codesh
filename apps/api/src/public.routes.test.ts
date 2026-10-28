import { keys } from "@gachipad/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { createHarness, type Harness, integration } from "./testing/harness.js";

const https = { "x-forwarded-proto": "https" };
const publicConfig = { network: "public" as const, publicUrl: "https://share.example.org" };

describe.skipIf(!integration)("public network boundaries", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it("sets Secure even on the HTTP hop from a TLS proxy, including logout", async () => {
    h = await createHarness({ config: publicConfig });
    const client = h.client();
    for (const response of [
      await client.get("/api/session", https),
      await client.request("POST", "/api/auth/logout", { headers: https }),
    ]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toMatch(/; Secure/);
    }
    expect((await h.client().get("/api/session")).statusCode).toBe(403);
  });

  it("never accepts forwarded HTTPS from an untrusted peer", async () => {
    h = await createHarness({ config: { ...publicConfig, trustProxy: ["10.0.0.0/24"] } });
    const forged = await h.app.inject({
      url: "/api/session",
      remoteAddress: "203.0.113.8",
      headers: { ...https, "x-forwarded-for": "10.0.0.8" },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.headers["set-cookie"]).toBeUndefined();
  });

  it("cannot rotate a forged XFF to bypass direct-public rate limits", async () => {
    const config = loadConfig();
    h = await createHarness({
      config: { ...publicConfig, rateLimit: { ...config.rateLimit, apiPerMinute: 2 } },
    });
    // Caddy appends the true peer. Left-hand values chosen by a client never become its identity.
    for (let i = 1; i <= 3; i++) {
      const response = await h.app.inject({
        url: "/api/session",
        remoteAddress: "127.0.0.1",
        headers: { ...https, "x-forwarded-for": `192.0.2.${i}, 198.51.100.9` },
      });
      expect(response.statusCode).toBe(i <= 2 ? 200 : 429);
    }
    expect(await h.valkey.get(keys.rateLimit("198.51.100.9", "api"))).toBe("3");
  });

  it("applies the public admin default to the actual client rather than the TLS proxy", async () => {
    const config = loadConfig({ GACHIPAD_NETWORK: "public", PUBLIC_URL: publicConfig.publicUrl });
    h = await createHarness({ config: { ...publicConfig, adminAllowCidr: config.adminAllowCidr } });
    const bearer = { ...https, authorization: "Bearer admin-token-for-tests" };
    expect(
      (await h.client({ ip: "203.0.113.7" }).get("/api/admin/security", bearer)).statusCode,
    ).toBe(404);
    expect((await h.client({ ip: "10.1.2.3" }).get("/api/admin/security", bearer)).statusCode).toBe(
      200,
    );
  });

  it("shares one atomic failed-lookup budget across IPs, refunds hits, audits once, and resets windows", async () => {
    h = await createHarness({ config: { ...publicConfig, codeFailureBudgetPerMinute: 3 } });
    const key = keys.rateLimit("global", "code-failures");
    const audit = vi.spyOn(h.stores.audit, "append");
    const owner = h.client();
    const share = await owner.request("POST", "/api/shares", { body: {}, headers: https });
    expect(share.statusCode).toBe(200);
    const { code } = share.json<{ code: string }>();
    for (let i = 0; i < 5; i++)
      expect((await owner.get(`/api/codes/${code}`, https)).statusCode).toBe(200);
    expect(await h.valkey.hget(key, "count")).toBe("0");
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.client({ ip: `198.51.100.${i + 1}` }).get("/api/codes/999999", https),
      ),
    );
    expect(replies.map((r) => r.statusCode).sort()).toEqual([
      404, 404, 404, 429, 429, 429, 429, 429,
    ]);
    expect(replies.find((r) => r.statusCode === 429)?.headers["retry-after"]).toBeDefined();
    expect(audit.mock.calls.filter(([row]) => row.action === "code.lookup_limited")).toHaveLength(
      1,
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain("999999");
    // Exhaustion temporarily pauses even correct codes; API/id-based joins remain available.
    expect((await owner.get(`/api/codes/${code}`, https)).statusCode).toBe(429);
    expect((await owner.get("/api/session", https)).statusCode).toBe(200);
    await h.valkey.hset(key, "window", "1");
    expect((await owner.get(`/api/codes/${code}`, https)).statusCode).toBe(200);
    expect(await h.valkey.hget(key, "count")).toBe("0");
    expect(await h.valkey.ttl(key)).toBeGreaterThan(0);
  });

  it("keeps the internal code path independent of the global budget", async () => {
    h = await createHarness({ config: { codeFailureBudgetPerMinute: 1 } });
    for (let i = 0; i < 4; i++)
      expect((await h.client().get("/api/codes/999999")).statusCode).toBe(404);
    expect(await h.valkey.exists(keys.rateLimit("global", "code-failures"))).toBe(0);
  });

  it("does not treat internet neighbours or a shared NAT as a trusted discovery group", async () => {
    h = await createHarness({ config: publicConfig });
    const owner = h.client({ ip: "198.51.100.7" });
    const neighbour = h.client({ ip: "198.51.100.7" });
    const created = await owner.request("POST", "/api/shares", {
      body: { title: "Private discovery", files: [{ path: "a.txt", content: "PRIVATE_PREVIEW" }] },
      headers: https,
    });
    expect(created.statusCode).toBe(200);
    const first = (await owner.get("/api/session", https)).json<{ net: string }>();
    const second = (await neighbour.get("/api/session", https)).json<{ net: string }>();
    expect(first.net).not.toBe(second.net);
    const nearby = await neighbour.get("/api/nearby", https);
    expect(nearby.statusCode).toBe(200);
    expect(nearby.json()).toEqual([]);
  });

  it("keeps the global admin budget when an operator widens the allowlist to the internet", async () => {
    h = await createHarness({ config: { ...publicConfig, adminAllowCidr: ["0.0.0.0/0"] } });
    const now = Date.now();
    await h.valkey.hset(keys.rateLimit("global", "admin-token-budget"), {
      tokens: 0,
      at: now,
      pause: now + 30000,
    });
    const response = await h
      .client()
      .get("/api/admin/security", { ...https, authorization: "Bearer admin-token-for-tests" });
    expect(response.statusCode).toBe(429);
  });

  it("fails closed if the shared code-budget store cannot admit a lookup", async () => {
    h = await createHarness({ config: publicConfig });
    const evalScript = h.valkey.eval.bind(h.valkey);
    vi.spyOn(h.valkey, "eval").mockImplementation((...args: Parameters<typeof h.valkey.eval>) => {
      if (args[2] === keys.rateLimit("global", "code-failures"))
        return Promise.reject(new Error("OOM command not allowed"));
      return evalScript(...args);
    });
    expect((await h.client().get("/api/codes/999999", https)).statusCode).toBe(503);
  });
});
