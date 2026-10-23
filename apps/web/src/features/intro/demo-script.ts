/*
 * The scripted editing session behind the hero demo. Two typists ("a" and "b") fill four small files
 * at the same time. Everything here is plain data and pure functions so the timeline can be tested
 * without a browser; DemoEditor feeds the resulting edits into CodeMirror.
 */

export type Who = "a" | "b";

/** Where a typist's cursor jumps to, found by searching the current document for `text`. */
export type Anchor =
  | { after: string }
  | { before: string }
  | { endOfLine: string }
  | { endOfDoc: true };

export type Step =
  | { who: Who; wait: number }
  | { who: Who; move: Anchor }
  | { who: Who; type: string }
  | { who: Who; erase: number };

export interface Scene {
  /** Language registry id; also picks the grammar. */
  readonly languageId: string;
  readonly filename: string;
  /** Text that is already in the file when the scene starts. */
  readonly base: string;
  readonly steps: readonly Step[];
}

export interface Cursors {
  a: number;
  b: number;
}

export type Op =
  | { who: Who; kind: "wait" }
  | { who: Who; kind: "move"; to: Anchor }
  | { who: Who; kind: "insert"; text: string }
  | { who: Who; kind: "erase" };

export interface TimedOp {
  readonly t: number;
  readonly op: Op;
}

export interface Edit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** Pause after a scene has finished typing, before the next file opens. */
export const SCENE_HOLD_MS = 2600;
const MOVE_MS = 420;

export const SCENES: readonly Scene[] = [
  {
    languageId: "typescript",
    filename: "api.ts",
    base: 'import { db } from "./db";\n\nasync function user(id) {\n  \n}',
    steps: [
      { who: "a", wait: 500 },
      { who: "a", move: { after: "user(id) {\n  " } },
      {
        who: "a",
        type: "const row = await db.get(id);\n  if (!row) return null;\n  return { ...row, active: true };",
      },
      { who: "b", wait: 900 },
      { who: "b", move: { after: "user(id" } },
      { who: "b", type: ": string" },
      { who: "b", wait: 1500 },
      { who: "b", move: { endOfDoc: true } },
      { who: "b", type: "\n\nexport const LIMIT = 50;" },
    ],
  },
  {
    languageId: "python",
    filename: "stats.py",
    base: "from statistics import mean\n\ndef summarize(scores):",
    steps: [
      { who: "a", wait: 500 },
      { who: "a", move: { endOfLine: "def summarize(scores):" } },
      { who: "a", type: '\n    total = mean(scores)\n    return {"mean": total}' },
      { who: "b", wait: 700 },
      { who: "b", move: { before: "def summarize" } },
      { who: "b", type: "# average of the scores\n" },
      { who: "b", wait: 500 },
      { who: "b", move: { after: "summarize(scores" } },
      { who: "b", type: ": list[float]" },
      { who: "b", wait: 700 },
      { who: "b", move: { endOfDoc: true } },
      { who: "b", type: "\n\nprint(summarize([4, 8, 15]))" },
    ],
  },
  {
    languageId: "go",
    filename: "main.go",
    base: 'package main\n\nimport "fmt"\n\nfunc main() {\n\t\n}',
    steps: [
      { who: "a", wait: 500 },
      { who: "a", move: { after: "func main() {\n\t" } },
      {
        who: "a",
        type: 'nums := []int{1, 2}\n\tfor _, n := range nums {\n\t\tfmt.Println("n:", n*2)\n\t}',
      },
      { who: "b", wait: 800 },
      { who: "b", move: { before: "func main" } },
      { who: "b", type: "// double each number\n" },
      { who: "b", wait: 1600 },
      { who: "b", move: { after: "[]int{1, 2" } },
      { who: "b", type: ", 3" },
    ],
  },
  {
    languageId: "sql",
    filename: "report.sql",
    base: "SELECT team, COUNT(*) AS members\nFROM users",
    steps: [
      { who: "a", wait: 600 },
      { who: "a", move: { endOfLine: "FROM users" } },
      { who: "a", type: "\nWHERE active = true" },
      { who: "a", wait: 3200 },
      { who: "a", move: { endOfLine: "GROUP BY team" } },
      { who: "a", type: "\nORDER BY members DESC;" },
      { who: "b", wait: 300 },
      { who: "b", move: { before: "SELECT" } },
      { who: "b", type: "-- headcount per team\n" },
      { who: "b", wait: 1500 },
      { who: "b", move: { endOfLine: "WHERE active = true" } },
      { who: "b", type: "\nGROUP BY team" },
    ],
  },
];

/** Deterministic 0..1 value so every run types with the same rhythm. */
function jitter(index: number): number {
  const x = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function charDelay(char: string, index: number): number {
  if (char === "\n") return 190;
  if (char === " " || char === "\t") return 32 + jitter(index) * 24;
  return 46 + jitter(index) * 58;
}

/** Expands a scene into single-character operations on a shared clock (milliseconds). */
export function buildTimeline(scene: Scene): { ops: readonly TimedOp[]; duration: number } {
  const clocks: Record<Who, number> = { a: 0, b: 0 };
  const ops: TimedOp[] = [];
  let index = 0;
  for (const step of scene.steps) {
    const who = step.who;
    if ("wait" in step) {
      clocks[who] += step.wait;
    } else if ("move" in step) {
      clocks[who] += MOVE_MS;
      ops.push({ t: clocks[who], op: { who, kind: "move", to: step.move } });
    } else if ("type" in step) {
      for (const char of step.type) {
        clocks[who] += charDelay(char, index++);
        ops.push({ t: clocks[who], op: { who, kind: "insert", text: char } });
      }
    } else {
      for (let i = 0; i < step.erase; i++) {
        clocks[who] += 70;
        ops.push({ t: clocks[who], op: { who, kind: "erase" } });
      }
    }
  }
  // Stable sort keeps each typist's own order when two operations share a timestamp.
  const sorted = ops
    .map((op, order) => ({ op, order }))
    .sort((x, y) => x.op.t - y.op.t || x.order - y.order)
    .map(({ op }) => op);
  return { ops: sorted, duration: Math.max(clocks.a, clocks.b) };
}

export function resolveAnchor(doc: string, anchor: Anchor): number | null {
  if ("endOfDoc" in anchor) return doc.length;
  if ("after" in anchor) {
    const at = doc.indexOf(anchor.after);
    return at === -1 ? null : at + anchor.after.length;
  }
  if ("before" in anchor) {
    const at = doc.indexOf(anchor.before);
    return at === -1 ? null : at;
  }
  const at = doc.indexOf(anchor.endOfLine);
  if (at === -1) return null;
  const end = doc.indexOf("\n", at);
  return end === -1 ? doc.length : end;
}

/** Document text plus both cursors. `apply` returns the edit it made, or null for a cursor move. */
export class DemoModel {
  doc: string;
  cursors: Cursors;

  constructor(base: string) {
    this.doc = base;
    // Both typists start at the end of the file, like two people who just opened it.
    this.cursors = { a: base.length, b: base.length };
  }

  apply(op: Op): Edit | null {
    const cursor = this.cursors[op.who];
    if (op.kind === "move") {
      this.cursors[op.who] = resolveAnchor(this.doc, op.to) ?? cursor;
      return null;
    }
    if (op.kind === "insert") {
      this.doc = this.doc.slice(0, cursor) + op.text + this.doc.slice(cursor);
      const other: Who = op.who === "a" ? "b" : "a";
      if (this.cursors[other] > cursor) this.cursors[other] += op.text.length;
      this.cursors[op.who] = cursor + op.text.length;
      return { from: cursor, to: cursor, insert: op.text };
    }
    if (op.kind === "erase" && cursor > 0) {
      this.doc = this.doc.slice(0, cursor - 1) + this.doc.slice(cursor);
      const other: Who = op.who === "a" ? "b" : "a";
      if (this.cursors[other] >= cursor) this.cursors[other] -= 1;
      this.cursors[op.who] = cursor - 1;
      return { from: cursor - 1, to: cursor, insert: "" };
    }
    return null;
  }
}

/** The finished file and cursor positions, used for the reduced-motion view. */
export function finalState(scene: Scene): { doc: string; cursors: Cursors } {
  const model = new DemoModel(scene.base);
  for (const { op } of buildTimeline(scene).ops) model.apply(op);
  return { doc: model.doc, cursors: { ...model.cursors } };
}

/** 1-based line and column of a position, for the status bar. */
export function lineColumn(doc: string, position: number): { line: number; col: number } {
  const before = doc.slice(0, position);
  const line = before.split("\n").length;
  return { line, col: position - (before.lastIndexOf("\n") + 1) + 1 };
}
