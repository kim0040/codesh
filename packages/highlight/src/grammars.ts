/*
 * Lazy grammar loaders. Every loader is a dynamic import, so a grammar only reaches the browser
 * when a share actually uses it.
 *
 * `PRECISE_LOADERS` lists languages with an incremental Lezer parser. Other languages use a
 * CodeMirror stream mode or an explicitly documented related grammar mapping.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { languages as codemirrorLanguages } from "@codemirror/language-data";

export type GrammarLoader = () => Promise<LanguageSupport>;

type CustomModeId =
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

const customStreamLoader =
  (id: CustomModeId): GrammarLoader =>
  () =>
    import("./custom-modes.js").then((m) => m.loadCustomMode(id));

/** Direct stream modes that have no `@codemirror/language-data` wrapper. */
export const CUSTOM_STREAM_LOADERS: Readonly<Record<string, GrammarLoader>> = {
  pegjs: () =>
    import("@codemirror/legacy-modes/mode/pegjs").then(
      (m) => new LanguageSupport(StreamLanguage.define(m.pegjs)),
    ),
  graphql: customStreamLoader("graphql"),
  prisma: customStreamLoader("prisma"),
  wgsl: customStreamLoader("wgsl"),
  zig: customStreamLoader("zig"),
  graphviz: customStreamLoader("graphviz"),
  mermaid: customStreamLoader("mermaid"),
  plantuml: customStreamLoader("plantuml"),
  prolog: customStreamLoader("prolog"),
  batch: customStreamLoader("batch"),
  autohotkey: customStreamLoader("autohotkey"),
  abap: customStreamLoader("abap"),
  stata: customStreamLoader("stata"),
  asciidoc: customStreamLoader("asciidoc"),
  restructuredtext: customStreamLoader("restructuredtext"),
  org: customStreamLoader("org"),
};

const languageData = new Map(codemirrorLanguages.map((d) => [d.name, d]));

/** Loader for an entry of `@codemirror/language-data`. Throws on first use if the name is unknown. */
export function languageDataLoader(name: string): GrammarLoader {
  return () => {
    const description = languageData.get(name);
    if (!description) throw new Error(`@codemirror/language-data has no language named "${name}"`);
    return description.load();
  };
}

/** True when `@codemirror/language-data` ships a language with exactly this name. */
export function hasLanguageData(name: string): boolean {
  return languageData.has(name);
}

/** Markdown fences resolve their info string through the registry (lazy: avoids an import cycle). */
async function loadMarkdown(): Promise<LanguageSupport> {
  const [{ markdown, markdownLanguage }, { fenceLanguage }] = await Promise.all([
    import("@codemirror/lang-markdown"),
    import("./languages.js"),
  ]);
  return markdown({ base: markdownLanguage, codeLanguages: fenceLanguage });
}

async function loadSql(dialect: string): Promise<LanguageSupport> {
  const mod = await import("@codemirror/lang-sql");
  const dialects = {
    standard: mod.StandardSQL,
    mysql: mod.MySQL,
    mariadb: mod.MariaSQL,
    mssql: mod.MSSQL,
    postgresql: mod.PostgreSQL,
    sqlite: mod.SQLite,
    plsql: mod.PLSQL,
    cassandra: mod.Cassandra,
  } as const;
  return mod.sql({ dialect: dialects[dialect as keyof typeof dialects] });
}

/** Languages parsed by a Lezer grammar, keyed by registry id. */
export const PRECISE_LOADERS: Readonly<Record<string, GrammarLoader>> = {
  angular: () => import("@codemirror/lang-angular").then((m) => m.angular()),
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  typescript: () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  c: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  csharp: () => import("@replit/codemirror-lang-csharp").then((m) => m.csharp()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
  sql: () => loadSql("standard"),
  mysql: () => loadSql("mysql"),
  "mariadb-sql": () => loadSql("mariadb"),
  "ms-sql": () => loadSql("mssql"),
  postgresql: () => loadSql("postgresql"),
  sqlite: () => loadSql("sqlite"),
  plsql: () => loadSql("plsql"),
  cql: () => loadSql("cassandra"),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  scss: () => import("@codemirror/lang-sass").then((m) => m.sass()),
  sass: () => import("@codemirror/lang-sass").then((m) => m.sass({ indented: true })),
  jinja: () => import("@codemirror/lang-jinja").then((m) => m.jinja()),
  less: () => import("@codemirror/lang-less").then((m) => m.less()),
  liquid: () => import("@codemirror/lang-liquid").then((m) => m.liquid()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  markdown: loadMarkdown,
  lezer: () => import("@codemirror/lang-lezer").then((m) => m.lezer()),
  promql: async () => {
    const [{ parser }, { LRLanguage }] = await Promise.all([
      import("@prometheus-io/lezer-promql"),
      import("@codemirror/language"),
    ]);
    return new LanguageSupport(LRLanguage.define({ parser }));
  },
  nix: () => import("@replit/codemirror-lang-nix").then((m) => m.nix()),
  solidity: () => import("@replit/codemirror-lang-solidity").then((m) => m.solidity),
  elixir: () => import("codemirror-lang-elixir").then((m) => m.elixir()),
  hcl: () => import("codemirror-lang-hcl").then((m) => m.hcl()),
  astro: () => import("@fazelstudio/codemirror-lang-astro").then((m) => m.astro()),
  groq: async () => {
    const { groq } = await import("@sanity/lezer-groq");
    return typeof groq === "function" ? groq() : groq;
  },
  vue: () => import("@codemirror/lang-vue").then((m) => m.vue()),
  svelte: () => import("@replit/codemirror-lang-svelte").then((m) => m.svelte()),
  webassembly: () => import("@codemirror/lang-wast").then((m) => m.wast()),
};

/** `LanguageDescription` helper for hosts that need one without going through the registry. */
export function describeLanguage(
  name: string,
  aliases: readonly string[],
  extensions: readonly string[],
  load: GrammarLoader,
): LanguageDescription {
  return LanguageDescription.of({ name, alias: [...aliases], extensions: [...extensions], load });
}
