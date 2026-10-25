import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

describe.skipIf(!integration)("system routes", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("GET /healthz answers ok and needs Valkey", async () => {
    const response = await h.client().get("/healthz");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("answers unknown routes with the contract error shape", async () => {
    const response = await h.client().get("/api/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("rejects invalid params and bodies with the validation code", async () => {
    const client = h.client();
    const badId = await client.get("/api/shares/not-an-id");
    expect(badId.statusCode).toBe(400);
    expect(badId.json<{ error: { code: string } }>().error.code).toBe("validation");

    const badBody = await client.post("/api/shares", { title: "x".repeat(500) });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json<{ error: { code: string } }>().error.code).toBe("validation");

    const malformed = await client.request("POST", "/api/shares", {
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("validation");
  });

  it("sends security headers and a CSP that names no origin", async () => {
    for (const url of ["/healthz", "/api/session", "/metrics"]) {
      const response = await h.client().get(url);
      const csp = String(response.headers["content-security-policy"]);
      expect(csp, url).toContain("default-src 'none'");
      expect(csp, url).not.toMatch(/https?:|\*|\/\//);
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
      expect(response.headers["x-frame-options"], url).toBe("DENY");
      expect(response.headers["referrer-policy"], url).toBe("no-referrer");
    }
  });

  it("GET /metrics exposes Prometheus text with request and share counters", async () => {
    const client = h.client();
    await createShare(client);
    await client.get("/api/session");
    const response = await h.client().get("/metrics");
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toMatch(/^text\/plain/);
    expect(response.body).toMatch(/^gachipad_shares_created_total [1-9]/m);
    expect(response.body).toMatch(
      /gachipad_http_request_duration_seconds_count\{[^}]*route="\/api\/session"[^}]*status="200"\} [1-9]/,
    );
    expect(response.body).toContain("gachipad_api_process_cpu_user_seconds_total");
  });
});

describe.skipIf(!integration)("rate limiting", () => {
  it("answers 429 rate_limited with Retry-After once the bucket is used up, per IP", async () => {
    const h = await createHarness({
      config: {
        rateLimit: {
          apiPerMinute: 5,
          codePerMinute: 100,
          createPerMinute: 100,
          loginPerMinute: 100,
        },
      },
    });
    try {
      const client = h.client();
      for (let i = 0; i < 5; i++) expect((await client.get("/api/session")).statusCode).toBe(200);
      const limited = await client.get("/api/session");
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);

      const key = `rl:${client.ip}:api`;
      expect(Number(await h.valkey.get(key))).toBe(6);
      expect(await h.valkey.ttl(key)).toBeGreaterThan(0);

      // Another address has its own bucket.
      expect((await h.client().get("/api/session")).statusCode).toBe(200);
      expect(await h.valkey.get("rl:127.0.0.1:api")).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("limits share creation separately from other calls", async () => {
    const h = await createHarness({
      config: {
        rateLimit: {
          apiPerMinute: 1000,
          codePerMinute: 100,
          createPerMinute: 2,
          loginPerMinute: 100,
        },
      },
    });
    try {
      const client = h.client();
      expect((await client.post("/api/shares")).statusCode).toBe(200);
      expect((await client.post("/api/shares")).statusCode).toBe(200);
      const third = await client.post("/api/shares");
      expect(third.statusCode).toBe(429);
      expect(third.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
      expect((await client.get("/api/session")).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });
});
