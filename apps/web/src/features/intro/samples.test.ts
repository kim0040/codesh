import { describe, expect, it } from "vitest";
import { SAMPLE_IDS, sampleLines, sampleText } from "./samples";
import { lang } from "./static-data";

describe("language samples", () => {
  it("covers languages the page knows a colour for", () => {
    for (const id of SAMPLE_IDS) expect(() => lang(id)).not.toThrow();
  });

  it("keeps every character of the source, one token list per line", () => {
    for (const id of SAMPLE_IDS) {
      const lines = sampleLines(id);
      expect(lines.length, id).toBeGreaterThanOrEqual(4);
      expect(lines.map((line) => line.map(([, text]) => text).join("")).join("\n"), id).toBe(
        sampleText(id),
      );
    }
  });

  it("colours keywords, strings, numbers and comments (SQL keeps its case-insensitive keywords)", () => {
    const kinds = new Set(
      sampleLines("typescript")
        .flat()
        .map(([kind]) => kind),
    );
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("number");
    expect(kinds).toContain("comment");
    expect(
      sampleLines("sql")
        .flat()
        .some(([kind, text]) => kind === "keyword" && text === "SELECT"),
    ).toBe(true);
    expect(
      sampleLines("sql")
        .flat()
        .some(([kind, text]) => kind === "string" && text === "'paid'"),
    ).toBe(true);
  });
});
