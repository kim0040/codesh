/*
 * Lazy grammar loaders. Every loader is a dynamic import, so a grammar only reaches the browser
 * when a share actually uses it.
 *
 * `PRECISE_LOADERS` lists the languages that run on an incremental Lezer parser (CodeMirror's
 * first-party packages plus the Replit C# and Svelte grammars). Languages that are missing here
 * fall back to CodeMirror's legacy stream modes through `@codemirror/language-data`; the registry
 * reports them as `engine: "stream"`. There is no maintained Lezer grammar for Kotlin, Swift, Ruby,
 * Shell or Dockerfile, so those five are stream-based.
 */
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages as codemirrorLanguages } from "@codemirror/language-data";

export type GrammarLoader = () => Promise<LanguageSupport>;

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
  less: languageDataLoader("LESS"),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  xml: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  markdown: loadMarkdown,
  vue: () => import("@codemirror/lang-vue").then((m) => m.vue()),
  svelte: () => import("@replit/codemirror-lang-svelte").then((m) => m.svelte()),
  webassembly: languageDataLoader("WebAssembly"),
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
