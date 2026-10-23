import { describe, expect, it } from "vitest";
import { canFormat, formatCode, minimalChange } from "./format-code";

function apply(before: string, change: { from: number; to: number; insert: string }): string {
  return before.slice(0, change.from) + change.insert + before.slice(change.to);
}

describe("minimalChange", () => {
  it("returns null for identical texts", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("covers only the part that differs", () => {
    expect(minimalChange("let a = 1;\nlet b = 2;", "let a = 1;\nlet b = 20;")).toEqual({
      from: 20,
      to: 20,
      insert: "0",
    });
    expect(minimalChange("abcXYZdef", "abcdef")).toEqual({ from: 3, to: 6, insert: "" });
  });

  it("reproduces the target text when applied", () => {
    const cases: [string, string][] = [
      ["", "hello"],
      ["hello", ""],
      ["aaaa", "aaa"],
      ["abcabc", "abcXabc"],
      ["a\nb\nc", "a\n  b\nc\n"],
      ["한글 테스트", "한글 시험 테스트"],
    ];
    for (const [before, after] of cases) {
      const change = minimalChange(before, after);
      expect(change ? apply(before, change) : before).toBe(after);
    }
  });
});

describe("formatting", () => {
  it("knows which languages can be formatted", () => {
    expect(canFormat("typescript")).toBe(true);
    expect(canFormat("json")).toBe(true);
    expect(canFormat("python")).toBe(false);
  });

  it("formats code with the requested indentation", async () => {
    const out = await formatCode("function f(){return {a:1}}", "typescript", {
      tabWidth: 4,
      useTabs: false,
    });
    expect(out).toBe("function f() {\n    return { a: 1 };\n}\n");
  });

  it("throws when the code does not parse", async () => {
    await expect(
      formatCode("{ not json", "json", { tabWidth: 2, useTabs: false }),
    ).rejects.toThrow();
  });
});
