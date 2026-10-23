import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  DemoModel,
  finalState,
  lineColumn,
  resolveAnchor,
  SCENES,
} from "./demo-script.js";

describe("demo script", () => {
  it("replays every scene to the intended finished file", () => {
    const finals = SCENES.map((scene) => finalState(scene).doc);
    expect(finals).toEqual([
      'import { db } from "./db";\n\nasync function user(id: string) {\n  const row = await db.get(id);\n  if (!row) return null;\n  return { ...row, active: true };\n}\n\nexport const LIMIT = 50;',
      'from statistics import mean\n\n# average of the scores\ndef summarize(scores: list[float]):\n    total = mean(scores)\n    return {"mean": total}\n\nprint(summarize([4, 8, 15]))',
      'package main\n\nimport "fmt"\n\n// double each number\nfunc main() {\n\tnums := []int{1, 2, 3}\n\tfor _, n := range nums {\n\t\tfmt.Println("n:", n*2)\n\t}\n}',
      "-- headcount per team\nSELECT team, COUNT(*) AS members\nFROM users\nWHERE active = true\nGROUP BY team\nORDER BY members DESC;",
    ]);
  });

  it("keeps lines short enough for a phone-width editor", () => {
    for (const scene of SCENES) {
      for (const line of finalState(scene).doc.split("\n")) {
        const width = line.replaceAll("\t", "    ").length;
        expect(width, `${scene.filename}: ${line}`).toBeLessThanOrEqual(36);
      }
    }
  });

  it("orders operations by time and keeps scenes between 5 and 12 seconds", () => {
    for (const scene of SCENES) {
      const { ops, duration } = buildTimeline(scene);
      for (let i = 1; i < ops.length; i++) {
        expect(ops[i]?.t).toBeGreaterThanOrEqual(ops[i - 1]?.t ?? 0);
      }
      expect(duration, scene.filename).toBeGreaterThan(5000);
      expect(duration, scene.filename).toBeLessThan(12000);
    }
  });

  it("resolves anchors and ignores ones that are missing", () => {
    expect(resolveAnchor("ab\ncd", { after: "b" })).toBe(2);
    expect(resolveAnchor("ab\ncd", { before: "c" })).toBe(3);
    expect(resolveAnchor("ab\ncd", { endOfLine: "a" })).toBe(2);
    expect(resolveAnchor("ab", { after: "zz" })).toBeNull();
    const model = new DemoModel("abc");
    model.apply({ who: "a", kind: "move", to: { after: "zz" } });
    expect(model.cursors.a).toBe(3);
  });

  it("shifts the other cursor when one typist inserts before it", () => {
    const model = new DemoModel("hello");
    model.apply({ who: "a", kind: "move", to: { before: "h" } });
    model.apply({ who: "a", kind: "insert", text: "x" });
    expect(model.doc).toBe("xhello");
    expect(model.cursors).toEqual({ a: 1, b: 6 });
  });

  it("reports line and column", () => {
    expect(lineColumn("ab\ncde", 5)).toEqual({ line: 2, col: 3 });
  });
});
