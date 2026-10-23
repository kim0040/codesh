import { describe, expect, it } from "vitest";
import {
  hashPin,
  randomKey,
  safeEqual,
  signCollabToken,
  verifyCollabToken,
  verifyPin,
} from "./crypto.js";

const payload = {
  shareId: "abcd1234",
  clientId: "11111111-1111-4111-8111-111111111111",
  name: "Min",
  color: "#336699",
  role: "edit" as const,
  exp: 2_000_000_000,
};

describe("PIN hashing", () => {
  it("verifies the right PIN and rejects others", async () => {
    const hash = await hashPin("4821");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPin("4821", hash)).toBe(true);
    expect(await verifyPin("4822", hash)).toBe(false);
    expect(await verifyPin("", hash)).toBe(false);
  });

  it("salts every hash and never stores the PIN", async () => {
    const [a, b] = await Promise.all([hashPin("4821"), hashPin("4821")]);
    expect(a).not.toBe(b);
    expect(a).not.toContain("4821");
  });

  it("refuses malformed stored hashes", async () => {
    for (const stored of ["", "plain", "scrypt$1$2$3", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPin("4821", stored), stored).toBe(false);
    }
  });
});

describe("collab token", () => {
  it("round-trips and has the documented shape", () => {
    const token = signCollabToken(payload, "secret");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyCollabToken(token, "secret", 1_000)).toEqual(payload);
  });

  it("rejects a wrong secret, tampering, expiry and garbage", () => {
    const token = signCollabToken(payload, "secret");
    const [body, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, role: "owner" })).toString("base64url");
    expect(verifyCollabToken(token, "other", 1_000)).toBeNull();
    expect(verifyCollabToken(`${forged}.${signature}`, "secret", 1_000)).toBeNull();
    expect(verifyCollabToken(`${body}.${signature}x`, "secret", 1_000)).toBeNull();
    expect(verifyCollabToken(token, "secret", payload.exp)).toBeNull();
    for (const bad of ["", "a", "a.b.c", "!!.??"]) {
      expect(verifyCollabToken(bad, "secret", 1_000), bad).toBeNull();
    }
  });
});

describe("secrets", () => {
  it("generates distinct URL-safe edit keys", () => {
    const keys = new Set(Array.from({ length: 50 }, randomKey));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("compares secrets of different lengths without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
