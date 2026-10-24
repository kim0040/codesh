import { describe, expect, it } from "vitest";
import { looksLikeSecret, zipEntryNames } from "./actions";

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

describe("zipEntryNames", () => {
  it("keeps ordinary paths and makes Windows-unsafe ones safe", () => {
    expect(zipEntryNames(["src/a.ts", "README.md"])).toEqual(["src/a.ts", "README.md"]);
    expect(zipEntryNames(["src\\win.ts", "con.txt", "a?.ts", "notes. "])).toEqual([
      "src/win.ts",
      "_con.txt",
      "a_.ts",
      "notes",
    ]);
  });

  it("numbers paths that Windows would store as one file", () => {
    expect(zipEntryNames(["A.ts", "a.ts", "a?.ts", "a_.ts"])).toEqual([
      "A.ts",
      "a (2).ts",
      "a_.ts",
      "a_ (2).ts",
    ]);
  });
});
