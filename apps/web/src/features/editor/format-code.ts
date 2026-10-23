import type { Plugin } from "prettier";

/** Prettier runs in the browser, loaded on demand: each parser is its own chunk. */

interface Plan {
  parser: string;
  plugins: () => Promise<Plugin[]>;
}

const estree = () => import("prettier/plugins/estree") as unknown as Promise<Plugin>;
const babel = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/babel")) as unknown as Plugin,
  await estree(),
];
const typescript = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/typescript")) as unknown as Plugin,
  await estree(),
];
const postcss = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/postcss")) as unknown as Plugin,
];
const html = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/html")) as unknown as Plugin,
];
const markdown = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/markdown")) as unknown as Plugin,
];
const yaml = async (): Promise<Plugin[]> => [
  (await import("prettier/plugins/yaml")) as unknown as Plugin,
];

const PLANS: Record<string, Plan> = {
  javascript: { parser: "babel", plugins: babel },
  jsx: { parser: "babel", plugins: babel },
  typescript: { parser: "typescript", plugins: typescript },
  tsx: { parser: "typescript", plugins: typescript },
  json: { parser: "json", plugins: babel },
  jsonc: { parser: "jsonc", plugins: babel },
  css: { parser: "css", plugins: postcss },
  scss: { parser: "scss", plugins: postcss },
  less: { parser: "less", plugins: postcss },
  html: { parser: "html", plugins: html },
  xml: { parser: "html", plugins: html },
  vue: { parser: "vue", plugins: html },
  markdown: { parser: "markdown", plugins: markdown },
  yaml: { parser: "yaml", plugins: yaml },
};

export function canFormat(languageId: string): boolean {
  return languageId in PLANS;
}

export interface FormatOptions {
  tabWidth: number;
  useTabs: boolean;
}

/** The formatted text, or throws when the code does not parse. */
export async function formatCode(
  text: string,
  languageId: string,
  options: FormatOptions,
): Promise<string> {
  const plan = PLANS[languageId];
  if (!plan) throw new Error(`no formatter for ${languageId}`);
  const [prettier, plugins] = await Promise.all([import("prettier/standalone"), plan.plugins()]);
  return prettier.format(text, {
    parser: plan.parser,
    plugins,
    tabWidth: options.tabWidth,
    useTabs: options.useTabs,
    printWidth: 100,
  });
}

/** One replacement covering only the part that differs, so remote cursors outside it stay put. */
export function minimalChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}
