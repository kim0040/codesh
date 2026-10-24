import { LanguageSupport, syntaxTree } from "@codemirror/language";
import { languages as codeMirrorLanguageData } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { hasLanguageData } from "./grammars.js";
import {
  fenceLanguage,
  findLanguage,
  getLanguage,
  LANGUAGES,
  languageForFilename,
  languagesForFilename,
  PLAIN_TEXT_ID,
} from "./languages.js";
import { NEW_LANGUAGE_IDS, SAMPLES } from "./samples.js";
import { EDITOR_THEMES } from "./themes.js";

const LEZER_LIST = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "php",
  "sql",
  "html",
  "css",
  "scss",
  "json",
  "yaml",
  "xml",
  "markdown",
  "vue",
  "svelte",
  "angular",
  "less",
  "jinja",
  "liquid",
  "webassembly",
  "lezer",
  "nix",
  "solidity",
  "elixir",
  "hcl",
  "promql",
  "astro",
  "groq",
];

/** No maintained Lezer grammar exists for these; they run on CodeMirror's stream modes. */
const STREAM_ONLY_FROM_PLAN = ["kotlin", "swift", "ruby", "shell", "dockerfile"];

const real = LANGUAGES.filter((language) => language.engine !== "none");

describe("language registry", () => {
  it("covers 200+ syntax-highlighted languages", () => {
    expect(real.length).toBeGreaterThanOrEqual(200);
  });

  it("has unique ids and well-formed entries", () => {
    expect(new Set(LANGUAGES.map((l) => l.id)).size).toBe(LANGUAGES.length);
    for (const language of LANGUAGES) {
      expect(language.id, language.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(language.name.trim(), language.id).not.toBe("");
      expect(language.color, language.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(language.mime, language.id).toMatch(/^[\w.+-]+\/[\w.+-]+$/);
      expect(language.defaultFilename, language.id).toMatch(/\S/);
      expect(language.aliases, language.id).toContain(language.id);
      for (const ext of language.extensions) expect(ext, language.id).toMatch(/^[a-z0-9+#.-]+$/i);
    }
  });

  it("resolves each id to itself and each default file name back to its language", () => {
    for (const language of LANGUAGES) {
      expect(findLanguage(language.id)?.id ?? language.id, language.id).toBeTypeOf("string");
      expect(getLanguage(language.id)).toBe(language);
    }
    for (const id of LEZER_LIST) {
      const language = getLanguage(id);
      expect(language, id).toBeDefined();
      expect(languagesForFilename(language?.defaultFilename ?? "").map((l) => l.id)).toContain(id);
    }
  });

  it("offers precise Lezer grammars for the planned languages", () => {
    for (const id of LEZER_LIST) expect(getLanguage(id)?.engine, id).toBe("lezer");
    expect(
      LANGUAGES.filter((language) => language.engine === "lezer").length,
    ).toBeGreaterThanOrEqual(25);
  });

  it("reports stream-based languages honestly", () => {
    for (const id of STREAM_ONLY_FROM_PLAN) expect(getLanguage(id)?.engine, id).toBe("stream");
    expect(getLanguage(PLAIN_TEXT_ID)?.engine).toBe("none");
  });

  it("has a sample, default path and declared mapping for every new entry", () => {
    expect(NEW_LANGUAGE_IDS).toHaveLength(57);
    for (const id of [...NEW_LANGUAGE_IDS, "angular"]) {
      const language = getLanguage(id);
      expect(language, id).toBeDefined();
      expect(SAMPLES[id], `${id} sample`).toBeTruthy();
      expect(
        languagesForFilename(language?.defaultFilename ?? "").map((item) => item.id),
        id,
      ).toContain(id);
      if (language?.engine === "mapped") {
        expect(language.mapping?.to, `${id} map target`).toBeTruthy();
        expect(language.mapping?.reason, `${id} map reason`).toMatch(/\S/);
      }
    }
  });

  it("highlights several token classes from each new sample in dark and light themes", async () => {
    const dark = EDITOR_THEMES.find((theme) => theme.appearance === "dark");
    const light = EDITOR_THEMES.find((theme) => theme.appearance === "light");
    if (!dark || !light) throw new Error("Both a dark and a light theme are required");

    for (const id of [...NEW_LANGUAGE_IDS, "angular"]) {
      const language = getLanguage(id);
      const sample = SAMPLES[id];
      if (!language || !sample) throw new Error(`${id} is missing its registry entry or sample`);
      const support = await language.load();
      const state = EditorState.create({ doc: sample, extensions: [support] });
      const tree = syntaxTree(state);
      for (const theme of [dark, light]) {
        const classes = new Set<string>();
        highlightTree(tree, theme.highlightStyle, (_from, _to, className) => {
          if (className) classes.add(className);
        });
        expect(classes.size, `${id} under ${theme.id}`).toBeGreaterThan(1);
      }
    }
  }, 60_000);

  it("only references names that exist in @codemirror/language-data", () => {
    const custom = new Set([
      "PEG.js",
      "PromQL",
      "GraphQL",
      "Prisma",
      "WGSL",
      "Zig",
      "Graphviz DOT",
      "Mermaid",
      "PlantUML",
      "Prolog",
      "Windows Batch",
      "AutoHotkey",
      "ABAP",
      "Stata",
      "AsciiDoc",
      "reStructuredText",
      "Org mode",
    ]);
    const missing = LANGUAGES.filter(
      (language) =>
        language.engine === "stream" &&
        !hasLanguageData(language.name) &&
        !custom.has(language.name),
    ).map((language) => `${language.id} (${language.name})`);
    // Direct legacy modes and project-owned stream modes are deliberately listed separately.
    expect(missing).toEqual([]);
  });

  it("registers every @codemirror/language-data entry and the otherwise-missing PEG.js mode", () => {
    const missing = codeMirrorLanguageData
      .map((language) => language.name)
      .filter((name) => !LANGUAGES.some((language) => language.name === name));
    expect(missing).toEqual([]);
    expect(getLanguage("pegjs")?.engine).toBe("stream");
  });

  it("loads every grammar lazily", async () => {
    const failures: string[] = [];
    await Promise.all(
      LANGUAGES.map(async (language) => {
        try {
          const support = await language.load();
          if (!(support instanceof LanguageSupport))
            failures.push(`${language.id}: not a LanguageSupport`);
        } catch (error) {
          failures.push(`${language.id}: ${String(error)}`);
        }
      }),
    );
    expect(failures).toEqual([]);
  }, 60_000);

  it("finds languages by alias, extension and fence info string", () => {
    expect(findLanguage("TS")?.id).toBe("typescript");
    expect(findLanguage("c++")?.id).toBe("cpp");
    expect(findLanguage("c#")?.id).toBe("csharp");
    expect(findLanguage("golang")?.id).toBe("go");
    expect(findLanguage("bash")?.id).toBe("shell");
    expect(findLanguage("yml")?.id).toBe("yaml");
    expect(findLanguage("py")?.id).toBe("python");
    expect(findLanguage("kt")?.id).toBe("kotlin");
    expect(findLanguage("nope-language")).toBeUndefined();
    expect(fenceLanguage("ts title=a.ts")?.name).toBe("TypeScript");
    expect(fenceLanguage("language-python")?.name).toBe("Python");
    expect(fenceLanguage("{.rust}")?.name).toBe("Rust");
    expect(fenceLanguage("")).toBeNull();
    expect(fenceLanguage("nope-language")).toBeNull();
    expect(fenceLanguage("text")).toBeNull();
  });

  it.each([
    ["main.go", "go"],
    ["App.tsx", "tsx"],
    ["app.test.tsx", "tsx"],
    ["types.d.ts", "typescript"],
    ["script.PY", "python"],
    ["Dockerfile", "dockerfile"],
    ["Dockerfile.dev", "dockerfile"],
    ["api.dockerfile", "dockerfile"],
    ["Gemfile", "ruby"],
    ["CMakeLists.txt", "cmake"],
    ["nginx.conf", "nginx"],
    ["src/main/Main.kt", "kotlin"],
    ["C:\\proj\\Program.cs", "csharp"],
    ["README.md", "markdown"],
    ["style.scss", "scss"],
    ["notes.txt", PLAIN_TEXT_ID],
    ["Cargo.toml", "toml"],
    ["data.json", "json"],
    ["page.vue", "vue"],
    ["page.svelte", "svelte"],
    ["src/app.component.html", "angular"],
  ])("maps %s to %s", (filename, id) => {
    expect(languageForFilename(filename)?.id).toBe(id);
  });

  it("returns nothing for unknown file names", () => {
    expect(languagesForFilename("noextension")).toEqual([]);
    expect(languagesForFilename("archive.zzzz")).toEqual([]);
  });
});
