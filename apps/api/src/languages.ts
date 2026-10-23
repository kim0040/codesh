/**
 * Language ids for uploaded files, by extension. Ids are the lower-case names the editor's
 * language registry uses; anything unknown is `plaintext`.
 */
export const DEFAULT_LANGUAGE = "plaintext";

const BY_EXTENSION: Record<string, string> = {
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  dart: "dart",
  go: "go",
  html: "html",
  htm: "html",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  php: "php",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return DEFAULT_LANGUAGE;
  return BY_EXTENSION[name.slice(dot + 1)] ?? DEFAULT_LANGUAGE;
}
