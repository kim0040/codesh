import { createHmac } from "node:crypto";
import { signCollabToken, verifyCollabToken } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import { hashPin, randomKey, safeEqual, verifyPin } from "./crypto.js";

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

/** The format of §8 written out with node:crypto, independent of the Web Crypto code in shared. */
const referenceSign = (value: unknown, secret: string) => {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};

function referenceVerify(token: string, secret: string) {
  const [body, signature] = token.split(".") as [string, string];
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (signature !== expected) return null;
  return JSON.parse(Buffer.from(body, "base64url").toString());
}

describe("collab token format", () => {
  it("is signed by shared and verified by an independent implementation", async () => {
    for (const name of ["Min", "민수 🙂"]) {
      const token = await signCollabToken({ ...payload, name }, "secret");
      expect(referenceVerify(token, "secret")).toEqual({ ...payload, name });
      expect(referenceVerify(token, "other")).toBeNull();
    }
  });

  it("is verified by shared when an independent implementation signed it", async () => {
    for (const name of ["Min", "민수 🙂"]) {
      const token = referenceSign({ ...payload, name }, "secret");
      expect(await verifyCollabToken(token, "secret", 1_000)).toEqual({ ...payload, name });
      expect(await verifyCollabToken(token, "other", 1_000)).toBeNull();
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
