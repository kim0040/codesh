import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("api", () => {
  const app = buildApp();
  afterAll(() => app.close());

  it("answers GET /healthz", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("answers unknown routes with the contract error shape", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});

describe("config", () => {
  it("falls back to local defaults", () => {
    expect(loadConfig({})).toMatchObject({
      port: 3001,
      mongoUrl: "mongodb://localhost:27017/codesh",
      valkeyUrl: "redis://localhost:6379",
      adminToken: "",
      trustProxy: [],
      production: false,
    });
  });

  it("reads env and splits TRUST_PROXY", () => {
    const config = loadConfig({ PORT: "4000", TRUST_PROXY: "10.0.0.0/8, 192.168.0.0/16," });
    expect(config.port).toBe(4000);
    expect(config.trustProxy).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });

  it("refuses default secrets in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET/);
    const strong = "x".repeat(32);
    expect(
      loadConfig({ NODE_ENV: "production", SESSION_SECRET: strong, COLLAB_SECRET: strong })
        .production,
    ).toBe(true);
  });
});
