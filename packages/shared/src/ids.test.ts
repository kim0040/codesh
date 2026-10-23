import { describe, expect, it } from "vitest";
import {
  fileIdSchema,
  generateClientId,
  generateFileId,
  generateJoinCode,
  generateLabCode,
  generateLabId,
  generateShareId,
  isClientId,
  isFileId,
  isJoinCode,
  isShareId,
  joinCodeSchema,
  shareIdSchema,
} from "./ids.js";

const RUNS = 2000;

describe("share id", () => {
  it("generates 8 base62 chars with at least one letter", () => {
    for (let i = 0; i < RUNS; i++) {
      const id = generateShareId();
      expect(id).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(id).toMatch(/[A-Za-z]/);
      expect(isShareId(id)).toBe(true);
    }
  });

  it("does not repeat across a few thousand ids", () => {
    const ids = new Set(Array.from({ length: RUNS }, generateShareId));
    expect(ids.size).toBe(RUNS);
  });

  it("rejects wrong length, symbols and digit-only ids", () => {
    for (const bad of ["", "abc", "abcdefg", "abcdefghi", "abcd-efg", "12345678", "abcdefg "]) {
      expect(isShareId(bad)).toBe(false);
    }
    expect(shareIdSchema.safeParse("12345678").success).toBe(false);
    expect(shareIdSchema.safeParse("1234567a").success).toBe(true);
  });
});

describe("join code", () => {
  it("generates 6 digits without a leading zero", () => {
    for (let i = 0; i < RUNS; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^[1-9][0-9]{5}$/);
      expect(isJoinCode(code)).toBe(true);
    }
  });

  it("rejects leading zero, wrong length and non-digits", () => {
    for (const bad of ["012345", "12345", "1234567", "12345a", "", " 12345"]) {
      expect(isJoinCode(bad)).toBe(false);
    }
    expect(joinCodeSchema.safeParse("123456").success).toBe(true);
  });

  it("is never a valid share id", () => {
    expect(isShareId(generateJoinCode())).toBe(false);
  });
});

describe("file id", () => {
  it("accepts main and 8 char base62 ids", () => {
    expect(isFileId("main")).toBe(true);
    for (let i = 0; i < 200; i++) expect(isFileId(generateFileId())).toBe(true);
    expect(fileIdSchema.safeParse("main").success).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "Main", "mainx", "abc", "abcdefg!", "abcdefghi"]) {
      expect(isFileId(bad)).toBe(false);
    }
  });
});

describe("client id", () => {
  it("is a UUID v4", () => {
    expect(isClientId(generateClientId())).toBe(true);
    expect(isClientId("not-a-uuid")).toBe(false);
  });
});

describe("lab ids", () => {
  it("follow the share id and join code rules", () => {
    expect(isShareId(generateLabId())).toBe(true);
    expect(isJoinCode(generateLabCode())).toBe(true);
  });
});
