import { LanguageSupport, StreamLanguage } from "@codemirror/language";

export type CustomModeId =
  | "graphql"
  | "prisma"
  | "wgsl"
  | "zig"
  | "graphviz"
  | "mermaid"
  | "plantuml"
  | "prolog"
  | "batch"
  | "autohotkey"
  | "abap"
  | "stata"
  | "asciidoc"
  | "restructuredtext"
  | "org";

interface ModeSpec {
  readonly keywords: readonly string[];
  readonly types?: readonly string[];
  readonly atoms?: readonly string[];
  readonly commentPrefixes?: readonly string[];
  readonly commentWords?: readonly string[];
  readonly firstColumnComments?: readonly string[];
  readonly caseInsensitive?: boolean;
  readonly upperCaseVariables?: boolean;
  readonly blockComment?: readonly [start: string, end: string];
}

const SPECS: Readonly<Record<CustomModeId, ModeSpec>> = {
  graphql: {
    keywords: [
      "query",
      "mutation",
      "subscription",
      "fragment",
      "on",
      "type",
      "interface",
      "input",
      "enum",
      "scalar",
      "union",
      "directive",
      "schema",
      "extend",
      "implements",
      "repeatable",
      "query",
      "mutation",
    ],
    types: ["Int", "Float", "String", "Boolean", "ID"],
    atoms: ["true", "false", "null"],
    commentPrefixes: ["#"],
  },
  prisma: {
    keywords: [
      "generator",
      "datasource",
      "model",
      "enum",
      "type",
      "view",
      "@@id",
      "@@index",
      "@@map",
      "@id",
      "@unique",
      "@default",
      "@relation",
      "@map",
      "@updatedAt",
    ],
    types: ["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"],
    atoms: ["true", "false", "null", "autoincrement", "uuid", "now"],
    commentPrefixes: ["//", "#"],
  },
  wgsl: {
    keywords: [
      "alias",
      "break",
      "case",
      "const",
      "continue",
      "default",
      "discard",
      "else",
      "enable",
      "false",
      "fn",
      "for",
      "function",
      "if",
      "let",
      "loop",
      "override",
      "return",
      "struct",
      "switch",
      "true",
      "var",
      "while",
      "workgroup_size",
      "var<private>",
      "var<storage>",
      "var<uniform>",
    ],
    types: [
      "bool",
      "f16",
      "f32",
      "i32",
      "u32",
      "vec2",
      "vec3",
      "vec4",
      "mat4x4",
      "array",
      "atomic",
      "texture_2d",
      "sampler",
    ],
    atoms: ["true", "false"],
    commentPrefixes: ["//"],
  },
  zig: {
    keywords: [
      "addrspace",
      "align",
      "allowzero",
      "and",
      "anyframe",
      "anytype",
      "asm",
      "async",
      "await",
      "break",
      "catch",
      "comptime",
      "const",
      "continue",
      "defer",
      "else",
      "enum",
      "errdefer",
      "error",
      "export",
      "extern",
      "fn",
      "for",
      "if",
      "inline",
      "linksection",
      "noalias",
      "nosuspend",
      "opaque",
      "or",
      "orelse",
      "packed",
      "pub",
      "resume",
      "return",
      "struct",
      "suspend",
      "switch",
      "test",
      "threadlocal",
      "try",
      "union",
      "unreachable",
      "usingnamespace",
      "var",
      "volatile",
      "while",
    ],
    atoms: ["true", "false", "null", "undefined"],
    commentPrefixes: ["//"],
  },
  graphviz: {
    keywords: [
      "strict",
      "graph",
      "digraph",
      "subgraph",
      "node",
      "edge",
      "rankdir",
      "rank",
      "label",
      "color",
      "shape",
      "style",
    ],
    atoms: ["true", "false"],
    commentPrefixes: ["//", "#"],
    blockComment: ["/*", "*/"],
  },
  mermaid: {
    keywords: [
      "graph",
      "flowchart",
      "sequencediagram",
      "classdiagram",
      "statediagram",
      "erdiagram",
      "gantt",
      "journey",
      "pie",
      "participant",
      "actor",
      "title",
      "section",
      "direction",
      "subgraph",
      "end",
      "loop",
      "alt",
      "else",
      "opt",
      "par",
      "critical",
      "break",
      "rect",
      "note",
      "activate",
      "deactivate",
      "td",
      "tb",
      "bt",
      "lr",
      "rl",
    ],
    commentPrefixes: ["%%"],
    caseInsensitive: true,
  },
  plantuml: {
    keywords: [
      "actor",
      "participant",
      "boundary",
      "control",
      "entity",
      "database",
      "collections",
      "class",
      "interface",
      "enum",
      "component",
      "package",
      "title",
      "skinparam",
      "activate",
      "deactivate",
      "note",
      "as",
      "alt",
      "else",
      "opt",
      "loop",
      "group",
      "end",
      "hide",
      "show",
      "autonumber",
    ],
    commentPrefixes: ["'"],
    caseInsensitive: true,
  },
  prolog: {
    keywords: [
      "is",
      "not",
      "mod",
      "div",
      "fail",
      "true",
      "false",
      "write",
      "writeln",
      "read",
      "assert",
      "assertz",
      "retract",
      "member",
      "append",
      "length",
      "findall",
      "between",
    ],
    atoms: ["true", "false", "[]"],
    commentPrefixes: ["%"],
    upperCaseVariables: true,
    blockComment: ["/*", "*/"],
  },
  batch: {
    keywords: [
      "echo",
      "set",
      "if",
      "else",
      "for",
      "in",
      "do",
      "call",
      "goto",
      "exit",
      "exist",
      "defined",
      "errorlevel",
      "equ",
      "neq",
      "lss",
      "gtr",
      "leq",
      "geq",
      "not",
      "shift",
      "start",
      "copy",
      "del",
      "mkdir",
      "pushd",
      "popd",
    ],
    commentPrefixes: ["::"],
    commentWords: ["rem"],
    caseInsensitive: true,
  },
  autohotkey: {
    keywords: [
      "if",
      "else",
      "return",
      "global",
      "local",
      "static",
      "class",
      "extends",
      "loop",
      "while",
      "for",
      "until",
      "try",
      "catch",
      "throw",
      "switch",
      "case",
      "default",
      "send",
      "msgbox",
      "hotkey",
      "settimer",
      "sleep",
      "exitapp",
      "true",
      "false",
    ],
    commentPrefixes: [";"],
    caseInsensitive: true,
  },
  abap: {
    keywords: [
      "report",
      "program",
      "write",
      "data",
      "types",
      "table",
      "of",
      "type",
      "value",
      "select",
      "from",
      "where",
      "into",
      "loop",
      "endloop",
      "if",
      "else",
      "elseif",
      "endif",
      "class",
      "definition",
      "implementation",
      "method",
      "endmethod",
      "function",
      "endfunction",
      "call",
      "perform",
      "form",
      "endform",
      "return",
      "clear",
      "append",
      "modify",
      "delete",
      "read",
      "begin",
      "end",
      "structure",
      "public",
      "private",
      "protected",
    ],
    commentPrefixes: ['"'],
    firstColumnComments: ["*"],
    caseInsensitive: true,
  },
  stata: {
    keywords: [
      "use",
      "generate",
      "gen",
      "replace",
      "summarize",
      "sum",
      "regress",
      "display",
      "local",
      "global",
      "foreach",
      "forvalues",
      "if",
      "in",
      "by",
      "sort",
      "merge",
      "collapse",
      "preserve",
      "restore",
      "clear",
      "input",
      "end",
      "label",
      "encode",
      "decode",
      "keep",
      "drop",
      "save",
      "import",
      "export",
    ],
    commentPrefixes: ["//"],
    firstColumnComments: ["*"],
    blockComment: ["/*", "*/"],
    caseInsensitive: true,
  },
  asciidoc: {
    keywords: [
      "source",
      "image",
      "link",
      "include",
      "xref",
      "example",
      "note",
      "tip",
      "warning",
      "important",
      "toc",
    ],
    commentPrefixes: ["//"],
    caseInsensitive: true,
  },
  restructuredtext: {
    keywords: [
      "code-block",
      "include",
      "image",
      "figure",
      "note",
      "warning",
      "important",
      "contents",
      "toctree",
      "attention",
      "seealso",
    ],
    commentPrefixes: [".."],
    caseInsensitive: true,
  },
  org: {
    keywords: [
      "begin_src",
      "end_src",
      "begin_example",
      "end_example",
      "title",
      "todo",
      "done",
      "priority",
      "property",
    ],
    commentPrefixes: ["# "],
    firstColumnComments: ["# "],
    caseInsensitive: true,
  },
};

function makeMode(spec: ModeSpec) {
  const keywords = new Set(spec.keywords.map((word) => normalize(word, spec)));
  const types = new Set((spec.types ?? []).map((word) => normalize(word, spec)));
  const atoms = new Set((spec.atoms ?? []).map((word) => normalize(word, spec)));
  const commentWords = new Set((spec.commentWords ?? []).map((word) => normalize(word, spec)));

  return StreamLanguage.define({
    startState: () => ({ inBlockComment: false }),
    token(stream, state) {
      if (stream.eatSpace()) return null;

      const block = spec.blockComment;
      if (state.inBlockComment && block) {
        if (stream.match(new RegExp(`.*?${escapeRegex(block[1])}`)) !== null)
          state.inBlockComment = false;
        else stream.skipToEnd();
        return "comment";
      }
      if (block && stream.match(block[0])) {
        state.inBlockComment = true;
        if (stream.match(new RegExp(`.*?${escapeRegex(block[1])}`)) !== null)
          state.inBlockComment = false;
        return "comment";
      }
      if (
        spec.firstColumnComments?.some((prefix) => stream.column() === 0 && stream.match(prefix))
      ) {
        stream.skipToEnd();
        return "comment";
      }
      if (spec.commentPrefixes?.some((prefix) => stream.match(prefix))) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match(/"(?:\\.|[^"\\])*"?/)) return "string";
      if (stream.match(/'(?:\\.|[^'\\])*'?/)) return "string";
      if (stream.match(/`(?:\\.|[^`\\])*`?/)) return "string";
      if (stream.match(/@[A-Za-z_][\w-]*/)) return "meta";
      if (stream.match(/[-+]?(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)) return "number";

      const word = stream.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/) as RegExpMatchArray | null;
      if (word) {
        const key = normalize(word[0], spec);
        if (commentWords.has(key)) {
          stream.skipToEnd();
          return "comment";
        }
        if (keywords.has(key)) return "keyword";
        if (types.has(key) || /^[A-Z][A-Za-z0-9_]*$/.test(word[0])) return "type";
        if (atoms.has(key)) return "atom";
        if (stream.peek() === "(") return "builtin";
        if (spec.upperCaseVariables && /^[A-Z_]/.test(word[0])) return "variable";
        return null;
      }

      if (stream.match(/(?:->|::|:=|==|!=|<=|>=|=>|&&|\|\||[=+*/%!<>|&^~?-]+)/)) return "operator";
      if (stream.match(/[{}()[\],.;:]/)) return "punctuation";
      stream.next();
      return null;
    },
  });
}

function normalize(word: string, spec: ModeSpec): string {
  return spec.caseInsensitive ? word.toLowerCase() : word;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadCustomMode(id: CustomModeId): LanguageSupport {
  return new LanguageSupport(makeMode(SPECS[id]));
}
