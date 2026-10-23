/*
 * Language registry: 140+ programming languages with a lazily loaded CodeMirror grammar.
 *
 * Identity colours are taken from GitHub Linguist (https://github.com/github-linguist/linguist),
 * which is MIT-licensed data: Copyright (c) 2011-2022 GitHub, Inc. Languages Linguist does not
 * colour get a deterministic hash colour so that every language still has a stable dot.
 * The colour is an identity cue only: the language name is always shown next to it.
 */
import { type LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { oklchToHex } from "./color.js";
import { describeLanguage, languageDataLoader, PRECISE_LOADERS } from "./grammars.js";

export interface LanguageEntry {
  /** Stable key stored in the share document and synced to every participant. */
  readonly id: string;
  /** Display name; identical in Korean and English UI. */
  readonly name: string;
  /** Lower-case names accepted in Markdown fences, shebangs and settings (`id` and `name` included). */
  readonly aliases: readonly string[];
  /** File extensions without the dot, lower-case. */
  readonly extensions: readonly string[];
  /** Exact file names (`Dockerfile`, `Gemfile`). */
  readonly filenames: readonly string[];
  readonly defaultFilename: string;
  readonly mime: string;
  /** `#rrggbb` identity colour for dots and badges. */
  readonly color: string;
  /** `lezer`: incremental Lezer parser (precise). `stream`: CodeMirror legacy stream mode. `none`: plain text. */
  readonly engine: "lezer" | "stream" | "none";
  load(): Promise<LanguageSupport>;
}

interface Extras {
  /** Extra aliases. */
  a?: string[];
  /** Exact file names. */
  f?: string[];
  /** MIME type. */
  m?: string;
  /** Default file name. */
  d?: string;
  /** Name of the matching `@codemirror/language-data` entry when it differs from `name`. */
  ld?: string;
}

export const PLAIN_TEXT_ID = "plaintext";

// id, name, linguist colour ("" = none), extensions, extras
type Row = readonly [id: string, name: string, color: string, ext: string, extras?: Extras];

const ROWS: readonly Row[] = [
  // Lezer grammars first: they win ambiguous extensions.
  [
    "javascript",
    "JavaScript",
    "#f1e05a",
    "js mjs cjs",
    { a: ["js", "node", "ecmascript"], m: "text/javascript", d: "index.js" },
  ],
  [
    "typescript",
    "TypeScript",
    "#3178c6",
    "ts mts cts",
    { a: ["ts"], m: "application/typescript", d: "index.ts" },
  ],
  ["jsx", "JSX", "#f1e05a", "jsx", { m: "text/jsx", d: "App.jsx" }],
  ["tsx", "TSX", "#3178c6", "tsx", { m: "text/typescript-jsx", d: "App.tsx" }],
  [
    "python",
    "Python",
    "#3572A5",
    "py pyw pyi bzl",
    { a: ["py", "python3"], f: ["BUILD", "BUCK", "SConstruct"], m: "text/x-python", d: "main.py" },
  ],
  ["java", "Java", "#b07219", "java", { m: "text/x-java", d: "Main.java" }],
  ["kotlin", "Kotlin", "#A97BFF", "kt kts", { a: ["kt"], m: "text/x-kotlin", d: "Main.kt" }],
  ["c", "C", "#555555", "c h ino", { m: "text/x-csrc", d: "main.c" }],
  [
    "cpp",
    "C++",
    "#f34b7d",
    "cpp cc cxx hpp hh hxx c++ h++",
    { a: ["c++", "cplusplus"], m: "text/x-c++src", d: "main.cpp" },
  ],
  [
    "csharp",
    "C#",
    "#178600",
    "cs csx",
    { a: ["cs", "c#", "dotnet"], m: "text/x-csharp", d: "Program.cs" },
  ],
  ["go", "Go", "#00ADD8", "go", { a: ["golang"], m: "text/x-go", d: "main.go" }],
  ["rust", "Rust", "#dea584", "rs", { a: ["rs"], m: "text/x-rustsrc", d: "main.rs" }],
  [
    "php",
    "PHP",
    "#4F5D95",
    "php php3 php4 php5 php7 phtml",
    { m: "application/x-httpd-php", d: "index.php" },
  ],
  [
    "ruby",
    "Ruby",
    "#701516",
    "rb rake gemspec",
    {
      a: ["rb", "jruby", "macruby", "rbx"],
      f: ["Gemfile", "Rakefile"],
      m: "text/x-ruby",
      d: "main.rb",
    },
  ],
  ["swift", "Swift", "#F05138", "swift", { m: "text/x-swift", d: "main.swift" }],
  ["sql", "SQL", "#e38c00", "sql", { m: "text/x-sql", d: "query.sql" }],
  [
    "html",
    "HTML",
    "#e34c26",
    "html htm xhtml handlebars hbs",
    { a: ["xhtml"], m: "text/html", d: "index.html" },
  ],
  ["css", "CSS", "#663399", "css", { m: "text/css", d: "style.css" }],
  ["scss", "SCSS", "#c6538c", "scss", { m: "text/x-scss", d: "style.scss" }],
  [
    "json",
    "JSON",
    "#292929",
    "json map json5 webmanifest",
    { a: ["json5"], m: "application/json", d: "data.json" },
  ],
  ["yaml", "YAML", "#cb171e", "yaml yml", { a: ["yml"], m: "text/yaml", d: "config.yaml" }],
  [
    "xml",
    "XML",
    "#0060ac",
    "xml xsl xsd svg rss wsdl plist",
    { a: ["svg", "rss", "wsdl", "xsd"], m: "application/xml", d: "data.xml" },
  ],
  [
    "markdown",
    "Markdown",
    "#083fa1",
    "md markdown mkd",
    { a: ["md"], m: "text/x-markdown", d: "README.md" },
  ],
  [
    "shell",
    "Shell",
    "#89e051",
    "sh bash zsh ksh",
    {
      a: ["bash", "sh", "zsh", "shellscript", "console"],
      f: ["PKGBUILD", ".bashrc", ".zshrc", ".profile", ".bash_profile"],
      m: "text/x-sh",
      d: "script.sh",
    },
  ],
  [
    "dockerfile",
    "Dockerfile",
    "#384d54",
    "dockerfile",
    { a: ["docker"], f: ["Dockerfile"], m: "text/x-dockerfile", d: "Dockerfile" },
  ],
  ["vue", "Vue", "#41b883", "vue", { m: "text/x-vue", d: "App.vue" }],
  ["svelte", "Svelte", "#ff3e00", "svelte", { m: "text/x-svelte", d: "App.svelte" }],
  ["less", "LESS", "#1d365d", "less", { m: "text/x-less", d: "style.less" }],
  ["sass", "Sass", "#a53b70", "sass", { m: "text/x-sass", d: "style.sass" }],
  // Everything below runs on CodeMirror's stream modes via @codemirror/language-data.
  ["cql", "CQL", "", "cql", { a: ["cassandra"], d: "query.cql" }],
  ["jinja", "Jinja", "#a52a22", "j2 jinja jinja2"],
  ["liquid", "Liquid", "#67b8de", "liquid"],
  [
    "mariadb-sql",
    "MariaDB SQL",
    "#003545",
    "",
    { d: "query.sql", a: ["mariadb sql"], m: "text/x-mariadb" },
  ],
  ["ms-sql", "MS SQL", "#cc2927", "", { d: "query.sql", a: ["ms sql", "tsql"], m: "text/x-mssql" }],
  ["mysql", "MySQL", "#4479a1", "", { d: "query.sql", a: ["mysql"], m: "text/x-mysql" }],
  ["plsql", "PLSQL", "#dad8d8", "pls", { d: "query.sql", m: "text/x-plsql" }],
  [
    "postgresql",
    "PostgreSQL",
    "#336791",
    "",
    { d: "query.sql", a: ["postgres", "psql"], m: "text/x-pgsql" },
  ],
  ["sqlite", "SQLite", "#0f80cc", "", { d: "query.sql", m: "text/x-sqlite" }],
  ["webassembly", "WebAssembly", "#04133b", "wat wast", { a: ["wasm"], m: "text/webassembly" }],
  ["apl", "APL", "#5A8164", "dyalog apl"],
  ["pgp", "PGP", "", "asc pgp sig", { a: ["asciiarmor"], m: "application/pgp" }],
  ["asn1", "ASN.1", "", "asn asn1", { a: ["asn.1"] }],
  ["asterisk", "Asterisk", "#aa0000", "", { f: ["extensions.conf"], d: "extensions.conf" }],
  ["brainfuck", "Brainfuck", "#2F2530", "b bf"],
  ["cobol", "Cobol", "#a2a2a2", "cob cpy cbl"],
  ["clojure", "Clojure", "#db5855", "clj cljc cljx"],
  ["clojurescript", "ClojureScript", "#5881d8", "cljs"],
  ["gss", "Closure Stylesheets (GSS)", "#663399", "gss"],
  ["cmake", "CMake", "#DA3434", "cmake", { f: ["CMakeLists.txt"], d: "CMakeLists.txt" }],
  ["coffeescript", "CoffeeScript", "#244776", "coffee", { a: ["coffee", "coffee-script"] }],
  ["common-lisp", "Common Lisp", "#3fb68b", "cl lisp el", { a: ["lisp", "common lisp"] }],
  ["cypher", "Cypher", "", "cyp cypher"],
  ["cython", "Cython", "#fedf5b", "pyx pxd pxi"],
  ["crystal", "Crystal", "#000100", "cr"],
  ["d", "D", "#ba595e", "d"],
  ["dart", "Dart", "#00B4AB", "dart"],
  ["diff", "diff", "#88ff88", "diff patch", { a: ["patch"] }],
  ["dtd", "DTD", "", "dtd"],
  ["dylan", "Dylan", "#6c616e", "dylan dyl intr"],
  ["ebnf", "EBNF", "", ""],
  ["ecl", "ECL", "#8a1267", "ecl"],
  ["edn", "edn", "", "edn"],
  ["eiffel", "Eiffel", "#4d6977", "e"],
  ["elm", "Elm", "#60B5CC", "elm"],
  ["erlang", "Erlang", "#B83998", "erl hrl"],
  ["esper", "Esper", "", ""],
  ["factor", "Factor", "#636746", "factor"],
  ["fcl", "FCL", "", ""],
  ["forth", "Forth", "#341708", "forth fth 4th"],
  ["fortran", "Fortran", "#4d41b1", "f for f77 f90 f95"],
  ["fsharp", "F#", "#b845fc", "fs fsx fsi", { a: ["f#"] }],
  ["gas", "Gas", "#6e4c13", "s", { a: ["asm", "assembly"] }],
  ["gherkin", "Gherkin", "#5B2063", "feature"],
  ["groovy", "Groovy", "#e69f56", "groovy gradle", { f: ["Jenkinsfile"] }],
  ["haskell", "Haskell", "#5e5086", "hs"],
  ["haxe", "Haxe", "#df7900", "hx"],
  ["hxml", "HXML", "#df7900", "hxml"],
  ["http", "HTTP", "#005c9c", "http", { d: "request.http" }],
  ["idl", "IDL", "#a3522f", "pro"],
  ["json-ld", "JSON-LD", "#0c479c", "jsonld", { a: ["jsonld"] }],
  ["julia", "Julia", "#a270ba", "jl"],
  ["livescript", "LiveScript", "#499886", "ls", { a: ["ls"] }],
  ["lua", "Lua", "#000080", "lua"],
  ["mirc", "mIRC", "", "mrc"],
  ["mathematica", "Mathematica", "#dd1100", "nb wl wls"],
  ["modelica", "Modelica", "#de1d31", "mo"],
  ["mumps", "MUMPS", "", "mps"],
  ["mbox", "Mbox", "", "mbox"],
  ["nginx", "Nginx", "#009639", "", { f: ["nginx.conf"], d: "nginx.conf" }],
  ["nsis", "NSIS", "", "nsh nsi"],
  ["ntriples", "NTriples", "", "nt nq"],
  ["objective-c", "Objective-C", "#438eff", "m", { a: ["objc"] }],
  ["objective-cpp", "Objective-C++", "#6866fb", "mm", { a: ["objc++", "objective-c++"] }],
  ["ocaml", "OCaml", "#ef7a08", "ml mli mll mly"],
  ["octave", "Octave", "#e16737", "m", { a: ["matlab"] }],
  ["oz", "Oz", "#fab738", "oz"],
  ["pascal", "Pascal", "#E3F171", "p pas"],
  ["perl", "Perl", "#0298c3", "pl pm"],
  ["pig", "Pig", "#fcd7de", "pig"],
  ["powershell", "PowerShell", "#012456", "ps1 psd1 psm1", { a: ["pwsh", "ps"] }],
  [
    "properties",
    "Properties files",
    "",
    "properties ini in cfg",
    { a: ["ini", "properties", "env"] },
  ],
  ["protobuf", "ProtoBuf", "", "proto", { a: ["proto"] }],
  ["pug", "Pug", "#a86454", "pug jade", { a: ["jade"] }],
  ["puppet", "Puppet", "#302B6D", "pp"],
  ["q", "Q", "#0040ff", "q"],
  ["r", "R", "#198CE7", "r", { a: ["rscript"] }],
  ["rpm-changes", "RPM Changes", "", ""],
  ["rpm-spec", "RPM Spec", "#a42b2b", "spec"],
  ["sas", "SAS", "#B34936", "sas"],
  ["scala", "Scala", "#c22d40", "scala sc"],
  ["scheme", "Scheme", "#1e4aec", "scm ss"],
  ["sieve", "Sieve", "", "siv sieve"],
  ["smalltalk", "Smalltalk", "#596706", "st"],
  ["solr", "Solr", "", ""],
  ["sml", "SML", "#dc566d", "sml fun smackspec"],
  ["sparql", "SPARQL", "#0c4597", "rq sparql", { a: ["sparul"] }],
  ["spreadsheet", "Spreadsheet", "#217346", "", { a: ["excel", "formula"] }],
  ["squirrel", "Squirrel", "#800000", "nut"],
  ["stylus", "Stylus", "#ff6347", "styl"],
  ["stex", "sTeX", "#3D6117", ""],
  ["latex", "LaTeX", "#3D6117", "tex ltx", { a: ["tex"] }],
  ["systemverilog", "SystemVerilog", "#DAE1C2", "sv svh"],
  ["tcl", "Tcl", "#e4cc98", "tcl"],
  ["textile", "Textile", "#ffe7ac", "textile"],
  ["tiddlywiki", "TiddlyWiki", "", ""],
  ["tiki-wiki", "Tiki wiki", "", ""],
  ["toml", "TOML", "#9c4221", "toml", { f: ["Cargo.lock", "Pipfile"] }],
  ["troff", "Troff", "#ecdebe", "1 2 3 4 5 6 7 8 9", { a: ["groff", "roff"] }],
  ["ttcn", "TTCN", "", "ttcn ttcn3 ttcnpp"],
  ["ttcn-cfg", "TTCN_CFG", "", ""],
  ["turtle", "Turtle", "", "ttl"],
  ["webidl", "Web IDL", "", "webidl", { a: ["web idl"] }],
  ["vbnet", "VB.NET", "#945db7", "vb", { a: ["vb.net", "visual basic"] }],
  ["vbscript", "VBScript", "#15dcdc", "vbs"],
  ["velocity", "Velocity", "", "vtl"],
  ["verilog", "Verilog", "#b2b7f8", "v"],
  ["vhdl", "VHDL", "#adb2cb", "vhd vhdl"],
  ["xquery", "XQuery", "#5232e7", "xy xquery xq xqm xqy"],
  ["yacas", "Yacas", "", "ys"],
  ["z80", "Z80", "", "z80"],
  ["mscgen", "MscGen", "", "mscgen mscin msc"],
  ["xu", "Xù", "", "xu"],
  ["msgenny", "MsGenny", "", "msgenny"],
  ["angular", "Angular Template", "#dd0031", "", { a: ["angular template"] }],
  [
    PLAIN_TEXT_ID,
    "Plain text",
    "#8b949e",
    "txt text log",
    { a: ["text", "txt", "plain"], m: "text/plain", d: "notes.txt" },
  ],
];

/** Stable colour for languages Linguist leaves uncoloured: hash of the id → hue, fixed lightness/chroma. */
function hashColor(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return oklchToHex(0.62, 0.09, (h >>> 0) % 360);
}

/** Plain text still needs a `LanguageSupport` so hosts can treat every entry alike. */
function loadPlainText(): Promise<LanguageSupport> {
  const language = StreamLanguage.define({
    token(stream) {
      stream.skipToEnd();
      return null;
    },
  });
  return Promise.resolve(new LanguageSupport(language));
}

function build(row: Row): LanguageEntry {
  const [id, name, color, ext, extras = {}] = row;
  const preciseLoader = PRECISE_LOADERS[id];
  const isPlain = id === PLAIN_TEXT_ID;
  const extensions = ext.split(" ").filter(Boolean);
  const aliases = [
    ...new Set([id, name.toLowerCase(), ...(extras.a ?? []).map((a) => a.toLowerCase())]),
  ];
  return {
    id,
    name,
    aliases,
    extensions,
    filenames: extras.f ?? [],
    defaultFilename: extras.d ?? (extensions[0] ? `main.${extensions[0]}` : `${id}.txt`),
    mime: extras.m ?? `text/x-${id}`,
    color: color || hashColor(id),
    engine: isPlain ? "none" : preciseLoader ? "lezer" : "stream",
    load: isPlain ? loadPlainText : (preciseLoader ?? languageDataLoader(extras.ld ?? name)),
  };
}

export const LANGUAGES: readonly LanguageEntry[] = ROWS.map(build);

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
const byAlias = new Map<string, LanguageEntry>();
const byExtension = new Map<string, LanguageEntry[]>();
const byFilename = new Map<string, LanguageEntry>();
for (const language of LANGUAGES) {
  for (const alias of language.aliases) if (!byAlias.has(alias)) byAlias.set(alias, language);
  for (const ext of language.extensions) {
    byExtension.set(ext, [...(byExtension.get(ext) ?? []), language]);
  }
  for (const filename of language.filenames) byFilename.set(filename.toLowerCase(), language);
}

export function getLanguage(id: string): LanguageEntry | undefined {
  return byId.get(id);
}

/** Resolves a Markdown fence info string, a shebang interpreter or a user-typed name to a language. */
export function findLanguage(nameOrAlias: string): LanguageEntry | undefined {
  const key = nameOrAlias.trim().toLowerCase();
  return byAlias.get(key) ?? byId.get(key) ?? byExtension.get(key)?.[0];
}

/** All languages that claim this extension (lower-case, no dot), most common first. */
export function languagesForExtension(extension: string): readonly LanguageEntry[] {
  return byExtension.get(extension.toLowerCase().replace(/^\./, "")) ?? [];
}

export function languageForFilename(filename: string): LanguageEntry | undefined {
  return languagesForFilename(filename)[0];
}

/** Candidates for a path, strongest match first: exact file name, special patterns, then extension. */
export function languagesForFilename(path: string): readonly LanguageEntry[] {
  const base = path.split(/[\\/]/).pop() ?? path;
  const exact = byFilename.get(base.toLowerCase());
  if (exact) return [exact];
  if (/^dockerfile(\.[\w-]+)?$/i.test(base) || /\.dockerfile$/i.test(base)) {
    const docker = byId.get("dockerfile");
    if (docker) return [docker];
  }
  if (/^nginx.*\.conf$/i.test(base)) {
    const nginx = byId.get("nginx");
    if (nginx) return [nginx];
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return [];
  const ext = base.slice(dot + 1).toLowerCase();
  // `foo.d.ts`, `foo.test.tsx`: the last extension decides.
  return byExtension.get(ext) ?? [];
}

const descriptionCache = new Map<string, LanguageDescription>();

/** `LanguageDescription` for Markdown fences and other nested-language hosts. */
export function languageDescription(entry: LanguageEntry): LanguageDescription {
  let description = descriptionCache.get(entry.id);
  if (!description) {
    description = describeLanguage(entry.name, entry.aliases, entry.extensions, () => entry.load());
    descriptionCache.set(entry.id, description);
  }
  return description;
}

/** Markdown `codeLanguages` callback: "ts title=a.ts", "{.python}", "language-go" → description. */
export function fenceLanguage(info: string): LanguageDescription | null {
  const word = info
    .trim()
    .split(/[\s{},]+/)
    .find(Boolean);
  if (!word) return null;
  const key = word.replace(/^(language-|lang-|\.)/i, "");
  const entry = findLanguage(key);
  return entry && entry.id !== PLAIN_TEXT_ID ? languageDescription(entry) : null;
}
