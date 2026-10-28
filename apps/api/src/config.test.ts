import { describe, expect, it } from "vitest";
import { loadConfig, proxyWarnings } from "./config.js";

describe("config", () => {
  it("falls back to local defaults", () => {
    expect(loadConfig({})).toMatchObject({
      port: 3001,
      mongoUrl: "mongodb://localhost:27017/gachipad",
      databaseUrl: "mongodb://localhost:27017/gachipad",
      databaseUrlSet: false,
      valkeyUrl: "redis://localhost:6379",
      adminToken: "",
      storage: "mongodb",
      trustProxy: [],
      production: false,
    });
  });

  it("selects DATABASE_URL first and preserves MONGO_URL fallback and memory mode", () => {
    const selected = loadConfig({
      DATABASE_URL: "sqlite:///tmp/gachipad.db",
      MONGO_URL: "mongodb://hidden:secret@host/db",
    });
    expect(selected).toMatchObject({ storage: "sqlite", databaseUrl: "sqlite:///tmp/gachipad.db" });
    const fallback = loadConfig({ MONGO_URL: "postgresql://user:secret@host/db" });
    expect(fallback).toMatchObject({
      storage: "postgresql",
      databaseUrl: "postgresql://user:secret@host/db",
    });
    expect(loadConfig({ STORAGE: "memory" })).toMatchObject({
      storage: "memory",
      databaseUrl: "memory:",
    });
    expect(() => loadConfig({ DATABASE_URL: "file:///tmp/db" })).toThrow(
      "Unsupported database URL scheme",
    );
  });

  it("reports only explicit DATABASE_URL while preserving backend precedence", () => {
    for (const env of [{}, { STORAGE: "memory" }, { MONGO_URL: "sqlite::memory:" }])
      expect(loadConfig(env).databaseUrlSet).toBe(false);
    expect(loadConfig({ STORAGE: "memory", DATABASE_URL: "sqlite::memory:" })).toMatchObject({
      databaseUrlSet: true,
      storage: "sqlite",
      databaseUrl: "sqlite::memory:",
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
    expect(proxyWarnings(loadConfig({ ...prod, ADMIN_ALLOW_CIDR: "10.0.0.0/8" }))).toEqual([
      expect.stringContaining("TRUST_PROXY"),
      expect.stringContaining("ADMIN_ALLOW_CIDR"),
    ]);
    expect(
      proxyWarnings(
        loadConfig({ ...prod, ADMIN_ALLOW_CIDR: "10.0.0.0/8", TRUST_PROXY: "127.0.0.1/32" }),
      ),
    ).toEqual([]);
  });

  it("checks for updates by default and turns the check off with UPDATE_CHECK=off", () => {
    expect(loadConfig({}).update).toEqual({
      enabled: true,
      repo: "kim0040/gachipad",
      channel: "stable",
      apiUrl: "https://api.github.com",
      statusFile: "",
    });
    for (const value of ["off", "OFF", "false", "0", "no"])
      expect(loadConfig({ UPDATE_CHECK: value }).update.enabled, value).toBe(false);
    expect(loadConfig({ UPDATE_CHANNEL: "prerelease" }).update.channel).toBe("prerelease");
    expect(loadConfig({ UPDATE_API_URL: "http://127.0.0.1:9/" }).update.apiUrl).toBe(
      "http://127.0.0.1:9",
    );
    expect(() => loadConfig({ UPDATE_REPO: "not a repo" })).toThrow(/owner\/name/);
    expect(() => loadConfig({ UPDATE_API_URL: "file:///etc/passwd" })).toThrow();
  });
});

describe("admin CIDR config", () => {
  it("defaults to no restriction and parses IPv4/IPv6 CIDRs", () => {
    expect(loadConfig({}).adminAllowCidr).toEqual([]);
    expect(loadConfig({ ADMIN_ALLOW_CIDR: " 10.0.0.0/8, ::1/128 " }).adminAllowCidr).toEqual([
      "10.0.0.0/8",
      "::1/128",
    ]);
  });
  it("rejects malformed admin and trusted-proxy restrictions", () => {
    expect(() => loadConfig({ ADMIN_ALLOW_CIDR: "oops" })).toThrow("IPv4 and IPv6 separately");
    for (const field of ["ADMIN_ALLOW_CIDR", "TRUST_PROXY"])
      for (const value of ["oops", "10.0.0.0/33", "::1/129"])
        expect(() => loadConfig({ [field]: value })).toThrow();
  });
});

it("rejects universal proxy trust that would let anyone forge the client IP", () => {
  for (const value of ["0.0.0.0/0", "::/0"])
    expect(() => loadConfig({ TRUST_PROXY: value })).toThrow();
});

it("rejects weak production admin tokens and still permits disabling the API", () => {
  const production = {
    NODE_ENV: "production",
    SESSION_SECRET: "s".repeat(40),
    COLLAB_SECRET: "c".repeat(40),
  };
  expect(() => loadConfig({ ...production, ADMIN_TOKEN: "short" })).toThrow("ADMIN_TOKEN");
  expect(loadConfig({ ...production, ADMIN_TOKEN: "" }).adminToken).toBe("");
  expect(loadConfig({ ...production, ADMIN_TOKEN: "a".repeat(64) }).adminToken).toHaveLength(64);
});

it("keeps legacy/internal defaults and restricts public administrators to private and loopback networks", () => {
  expect(loadConfig({}).network).toBe("internal");
  const publicEnv = { GACHIPAD_NETWORK: "public", PUBLIC_URL: "https://share.example.org" };
  expect(loadConfig(publicEnv).adminAllowCidr).toEqual([
    "127.0.0.0/8",
    "::1/128",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "fc00::/7",
  ]);
  expect(loadConfig({ ...publicEnv, ADMIN_ALLOW_CIDR: "203.0.113.7/32" }).adminAllowCidr).toEqual([
    "203.0.113.7/32",
  ]);
  expect(loadConfig(publicEnv).codeFailureBudgetPerMinute).toBe(60);
  expect(loadConfig({ ...publicEnv, PUBLIC_URL: "HTTPS://Share.Example.Org" }).publicUrl).toBe(
    "https://share.example.org",
  );
  for (const url of [
    "",
    "http://share.example.org",
    "https://127.0.0.1",
    "https://[::1]",
    "https://gachipad.local",
    "https://gachipad.local.",
    "https://server",
    "https://share.example.org/path",
    "https://user:pass@share.example.org",
    "https://share.example.org?x=1",
  ])
    expect(() => loadConfig({ ...publicEnv, PUBLIC_URL: url }), url).toThrow(/Public mode/);
});
