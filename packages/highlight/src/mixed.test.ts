import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findLanguage, languageDescription } from "./languages.js";
import { SAMPLES } from "./samples.js";

/**
 * Names of the syntax nodes around the first occurrence of `needle`, innermost first, walking
 * through embedded languages (the chain crosses from the nested parser into its host).
 */
async function chainAt(languageId: string, doc: string, needle: string, offset = 0) {
  const entry = findLanguage(languageId);
  if (!entry) throw new Error(`no language ${languageId}`);
  const state = EditorState.create({ doc, extensions: [await entry.load()] });
  const tree = ensureSyntaxTree(state, doc.length, 10_000);
  if (!tree) throw new Error("parse timed out");
  const at = doc.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not in document`);
  const names: string[] = [];
  for (let node = tree.resolveInner(at + offset, 1); ; ) {
    names.push(node.name);
    if (!node.parent) break;
    node = node.parent;
  }
  return names;
}

describe("mixed-language highlighting", () => {
  it("parses JavaScript and CSS inside HTML", async () => {
    const html = SAMPLES.html ?? "";
    const script = await chainAt("html", html, "addEventListener");
    expect(script).toContain("CallExpression");
    expect(script).toContain("MemberExpression");
    const style = await chainAt("html", html, "margin");
    expect(style).toContain("PropertyName");
    expect(style).toContain("Declaration");
    expect(await chainAt("html", html, "<button", 1)).toContain("TagName");
  });

  it("parses fenced code in Markdown with the registry's language", async () => {
    await languageDescription(findLanguage("typescript") ?? never()).load();
    const chain = await chainAt("markdown", SAMPLES.markdown ?? "", "connect(");
    expect(chain).toContain("CallExpression");
    expect(chain).toContain("FencedCode");
  });

  it("leaves a fence with an unknown language as plain code text", async () => {
    const chain = await chainAt("markdown", "```nope\nlet x = 1\n```", "let x");
    expect(chain).toContain("CodeText");
    expect(chain).not.toContain("VariableDeclaration");
  });

  it("parses JSX inside JavaScript and TSX", async () => {
    expect(await chainAt("jsx", SAMPLES.jsx ?? "", "<button", 1)).toContain("JSXElement");
    const tsx = SAMPLES.tsx ?? "";
    expect(await chainAt("tsx", tsx, "<button", 1)).toContain("JSXElement");
    expect(await chainAt("tsx", tsx, "label: string")).toContain("InterfaceDeclaration");
  });

  it("parses script and style blocks in Vue", async () => {
    const vue = SAMPLES.vue ?? "";
    expect(await chainAt("vue", vue, "ref(")).toContain("CallExpression");
    expect(await chainAt("vue", vue, "color")).toContain("PropertyName");
  });

  it("parses scripts and blocks in Svelte", async () => {
    expect(await chainAt("svelte", SAMPLES.svelte ?? "", "filter(")).toContain("CallExpression");
  });

  it("parses HTML around PHP", async () => {
    const php = "<h1><?php echo $title; ?></h1>\n<?php function f(int $a): int { return $a; } ?>";
    expect(await chainAt("php", php, "<h1", 1)).toContain("OpenTag");
    expect(await chainAt("php", php, "echo")).toContain("EchoStatement");
    expect(await chainAt("php", php, "function")).toContain("FunctionDefinition");
  });
});

function never(): never {
  throw new Error("language missing");
}
