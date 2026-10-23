import { describe, expect, it } from "vitest";
import { signCollabToken, verifyCollabToken } from "./collab-token.js";

const payload = {
  shareId: "abcd1234",
  clientId: "11111111-1111-4111-8111-111111111111",
  name: "Min",
  color: "#336699",
  role: "edit" as const,
  exp: 2_000_000_000,
};

describe("collab token", () => {
  it("round-trips a signed payload", async () => {
    const token = await signCollabToken(payload, "secret");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyCollabToken(token, "secret", 1_000)).toEqual(payload);
  });

  it("rejects a wrong secret, tampering, expiry and garbage", async () => {
    const token = await signCollabToken(payload, "secret");
    const [body, sig] = token.split(".") as [string, string];
    expect(await verifyCollabToken(token, "other", 1_000)).toBeNull();
    expect(await verifyCollabToken(`${body}x.${sig}`, "secret", 1_000)).toBeNull();
    expect(await verifyCollabToken(token, "secret", payload.exp)).toBeNull();
    for (const bad of ["", "a", "a.b.c", "!!.??"]) {
      expect(await verifyCollabToken(bad, "secret", 1_000)).toBeNull();
    }
  });
});
