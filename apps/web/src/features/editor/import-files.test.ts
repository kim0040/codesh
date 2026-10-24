import { describe, expect, it } from "vitest";
import { decodeText } from "./import-files";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("decodeText", () => {
  it("turns Windows line endings into \\n and drops a byte order mark", () => {
    const text = new TextEncoder().encode("﻿a\r\nb\rc\n");
    expect(decodeText(text)).toBe("a\nb\nc\n");
  });

  it("reads UTF-16 files saved as Unicode on Windows", () => {
    // BOM, "h", "i", CR, LF in UTF-16LE.
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0, 0x0d, 0, 0x0a, 0))).toBe("hi\n");
  });

  it("falls back to the Korean Windows code page when the bytes are not UTF-8", () => {
    // "한글" in EUC-KR / CP949.
    expect(decodeText(bytes(0xc7, 0xd1, 0xb1, 0xdb))).toBe("한글");
  });

  it("skips binary files", () => {
    expect(decodeText(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00))).toBeNull();
  });
});
