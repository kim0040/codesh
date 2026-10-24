/*
 * Short example files for the language chips in the features section. They are written as plain
 * source and coloured here with a tiny tokenizer, so the page does not pull the grammars in; the
 * colours are the editor theme's own token colours (see static-data.ts).
 */
import type { CodeToken } from "./art";

interface Grammar {
  /** Line-comment marker. */
  comment: string;
  keywords: readonly string[];
  types?: readonly string[];
  /** Compare keywords without regard to case (SQL). */
  insensitive?: boolean;
  source: string;
}

const GRAMMARS = {
  typescript: {
    comment: "//",
    keywords: ["export", "function", "const", "return"],
    types: ["number"],
    source: `// total price
export function total(n: number) {
  const unit = 1200;
  return n > 0 ? n * unit : 0;
}`,
  },
  python: {
    comment: "#",
    keywords: ["def", "return", "if", "else"],
    types: ["int"],
    source: `# total price
def total(n: int) -> int:
    unit = 1200
    return n * unit if n else 0`,
  },
  go: {
    comment: "//",
    keywords: ["func", "return"],
    types: ["int"],
    source: `// total price
func total(n int) int {
	unit := 1200
	return n * unit
}`,
  },
  rust: {
    comment: "//",
    keywords: ["fn", "let"],
    types: ["u32"],
    source: `// total price
fn total(n: u32) -> u32 {
    let unit = 1200;
    n * unit
}`,
  },
  java: {
    comment: "//",
    keywords: ["static", "return"],
    types: ["int"],
    source: `// total price
static int total(int n) {
    int unit = 1200;
    return n * unit;
}`,
  },
  kotlin: {
    comment: "//",
    keywords: ["fun", "val", "return"],
    types: ["Int"],
    source: `// total price
fun total(n: Int): Int {
    val unit = 1200
    return n * unit
}`,
  },
  cpp: {
    comment: "//",
    keywords: ["const", "return"],
    types: ["int"],
    source: `// total price
int total(int n) {
  const int unit = 1200;
  return n > 0 ? n * unit : 0;
}`,
  },
  swift: {
    comment: "//",
    keywords: ["func", "let", "return"],
    types: ["Int"],
    source: `// total price
func total(_ n: Int) -> Int {
    let unit = 1200
    return n > 0 ? n * unit : 0
}`,
  },
  php: {
    comment: "//",
    keywords: ["function", "return"],
    types: ["int"],
    source: `// total price
function total(int $n): int {
    $unit = 1200;
    return $n * $unit;
}`,
  },
  sql: {
    comment: "--",
    keywords: ["SELECT", "AS", "FROM", "WHERE"],
    insensitive: true,
    source: `-- total price
SELECT id, qty * 1200 AS total
FROM orders
WHERE state = 'paid';`,
  },
} as const satisfies Record<string, Grammar>;

export type SampleId = keyof typeof GRAMMARS;

export const SAMPLE_IDS = Object.keys(GRAMMARS) as readonly SampleId[];

const PIECES = /("[^"]*"|'[^']*')|(\d+)|([A-Za-z_$][\w$]*)|([=<>?*+\-:!&|]+)|(\s+|.)/g;

function tokenizeLine(line: string, grammar: Grammar): CodeToken[] {
  const marker = line.indexOf(grammar.comment);
  const code = marker < 0 ? line : line.slice(0, marker);
  const tokens: CodeToken[] = [];
  for (const match of code.matchAll(PIECES)) {
    const [text, string, number, word, operator] = match;
    if (string) tokens.push(["string", text]);
    else if (number) tokens.push(["number", text]);
    else if (word) {
      const probe = grammar.insensitive ? word.toUpperCase() : word;
      const known = (list: readonly string[] = []) =>
        grammar.insensitive
          ? list.some((item) => item.toUpperCase() === probe)
          : list.includes(probe);
      if (known(grammar.keywords)) tokens.push(["keyword", text]);
      else if (known(grammar.types)) tokens.push(["type", text]);
      else if (code[(match.index ?? 0) + text.length] === "(") tokens.push(["function", text]);
      else tokens.push(["variable", text]);
    } else if (operator) tokens.push(["operator", text]);
    else tokens.push([null, text]);
  }
  if (marker >= 0) tokens.push(["comment", line.slice(marker)]);
  return tokens;
}

/** The sample for a language, one token list per line. */
export function sampleLines(id: SampleId): CodeToken[][] {
  return GRAMMARS[id].source.split("\n").map((line) => tokenizeLine(line, GRAMMARS[id]));
}

/** The sample's source text, for checks. */
export function sampleText(id: SampleId): string {
  return GRAMMARS[id].source;
}
