import { describe, expect, it } from "vitest";
import { compareSemver, formatSemver, parseSemver } from "./semver.js";
import { plainNotes } from "./updates.js";

const v = (value: string) => {
  const parsed = parseSemver(value);
  if (!parsed) throw new Error(`not semver: ${value}`);
  return parsed;
};

describe("semver", () => {
  it("parses release tags with or without v and drops build metadata", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(formatSemver(v("1.3.0-rc.1+build.5"))).toBe("1.3.0-rc.1");
    for (const bad of ["1.2", "01.2.3", "v1.2.3.4", "latest", "dev", "1.2.3-", ""])
      expect(parseSemver(bad), bad).toBeNull();
  });

  it("orders versions as Semantic Versioning 2.0.0 does", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.1.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      const [a, b] = [ordered[i - 1] as string, ordered[i] as string];
      expect(compareSemver(v(a), v(b)), `${a} < ${b}`).toBe(-1);
      expect(compareSemver(v(b), v(a)), `${b} > ${a}`).toBe(1);
    }
    expect(compareSemver(v("v1.2.3"), v("1.2.3+other"))).toBe(0);
  });
});

describe("release notes", () => {
  it("keeps plain text with line breaks and nothing that could render or hide", () => {
    expect(plainNotes("## Added\r\n- <b>x</b>\r\n\r\n\r\n\r\n- y\u0007‮")).toBe(
      "## Added\n- <b>x</b>\n\n- y",
    );
    expect(plainNotes("   ")).toBeNull();
    expect(plainNotes(null)).toBeNull();
    const long = plainNotes("x".repeat(10_000));
    expect(long?.length).toBe(4000);
    expect(long?.endsWith("…")).toBe(true);
  });
});
