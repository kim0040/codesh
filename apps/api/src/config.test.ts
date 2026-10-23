import { describe, expect, it } from "vitest";
import { loadConfig, proxyWarnings } from "./config.js";

describe("config", () => {
  it("falls back to local defaults", () => {
    expect(loadConfig({})).toMatchObject({
      port: 3001,
      mongoUrl: "mongodb://localhost:27017/codesh",
      valkeyUrl: "redis://localhost:6379",
      adminToken: "",
      storage: "mongo",
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

  it("warns in production when no proxy is trusted, and only then", () => {
    const strong = "x".repeat(32);
    const prod = { NODE_ENV: "production", SESSION_SECRET: strong, COLLAB_SECRET: strong };
    expect(proxyWarnings(loadConfig(prod))).toEqual([expect.stringContaining("TRUST_PROXY")]);
    expect(proxyWarnings(loadConfig({ ...prod, TRUST_PROXY: "10.0.0.0/8" }))).toEqual([]);
    expect(proxyWarnings(loadConfig({}))).toEqual([]);
  });
});
