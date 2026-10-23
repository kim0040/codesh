import { describe, expect, it } from "vitest";
import {
  baseName,
  clampIndex,
  firstLines,
  formatBytes,
  groupCode,
  parentDir,
  utf8Length,
} from "./format";

describe("formatBytes", () => {
  it("scales units and trims digits", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3072 GB");
  });
});

describe("groupCode", () => {
  it("splits a join code in two groups of three", () => {
    expect(groupCode("482913")).toBe("482 913");
    expect(groupCode("123")).toBe("123");
  });
});

describe("paths", () => {
  it("splits the last segment from the folder", () => {
    expect(baseName("src/lib/a.ts")).toBe("a.ts");
    expect(baseName("a.ts")).toBe("a.ts");
    expect(parentDir("src/lib/a.ts")).toBe("src/lib");
    expect(parentDir("a.ts")).toBe("");
  });
});

describe("text helpers", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("한글")).toBe(6);
  });

  it("keeps the first lines", () => {
    expect(firstLines("a\nb\nc\nd", 2)).toBe("a\nb");
    expect(firstLines("a", 5)).toBe("a");
  });

  it("clamps an index into a list", () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
  });
});
