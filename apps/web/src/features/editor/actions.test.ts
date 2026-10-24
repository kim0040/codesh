import { describe, expect, it } from "vitest";
import { looksLikeSecret } from "./actions";

describe("looksLikeSecret", () => {
  it("flags private keys and well-known token shapes", () => {
    expect(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true);
    expect(looksLikeSecret("aws_key = AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksLikeSecret(`token: ghp_${"a1B2".repeat(9)}`)).toBe(true);
    expect(looksLikeSecret(`const k = "sk-${"x".repeat(24)}"`)).toBe(true);
  });

  it("flags quoted credentials assigned to suggestive names", () => {
    expect(looksLikeSecret('password = "hunter2hunter2"')).toBe(true);
    expect(looksLikeSecret('{ "api_key": "abcd1234efgh" }')).toBe(true);
  });

  it("leaves ordinary code and short or huge pastes alone", () => {
    expect(looksLikeSecret("const total = items.reduce((a, b) => a + b, 0);")).toBe(false);
    expect(looksLikeSecret("password = input()")).toBe(false);
    expect(looksLikeSecret("AKIA")).toBe(false);
    expect(looksLikeSecret(`password = "${"x".repeat(200_001)}"`)).toBe(false);
  });
});
