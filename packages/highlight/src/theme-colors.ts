/*
 * Colour data for the four editor themes. Kept free of CodeMirror imports so tests and tooling can
 * check contrast without loading an editor.
 *
 * Token colours were generated in OKLCH (fixed lightness per theme, one hue per token) and then
 * rounded to hex; graphite's keyword/string and sand's string were nudged afterwards so that
 * keyword, string and comment stay ≥0.05 apart under simulated protanopia, deuteranopia and
 * tritanopia. Every token passes 4.5:1 on its own background, and the 13 colours of a theme
 * differ from each other by at least 0.04 in OKLab, so keyword, string and comment stay apart even
 * with colour-vision deficiencies; the theme additionally sets comments italic and keywords to
 * weight 500 so meaning never rests on colour alone.
 */
import { mix } from "./color.js";

export const TOKEN_NAMES = [
  "keyword",
  "string",
  "comment",
  "number",
  "type",
  "function",
  "variable",
  "property",
  "operator",
  "tag",
  "attribute",
  "regexp",
  "invalid",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export type ThemeId = "slate" | "graphite" | "paper" | "sand";

export interface ThemePalette {
  readonly id: ThemeId;
  readonly appearance: "dark" | "light";
  readonly background: string;
  readonly foreground: string;
  readonly tokens: Readonly<Record<TokenName, string>>;
}

export interface ThemeSurfaces {
  /** Selected text. */
  readonly selection: string;
  /** Highlight of the line holding the cursor. */
  readonly activeLine: string;
  /** Other occurrences of the selected word. */
  readonly selectionMatch: string;
  readonly searchMatch: string;
  readonly searchMatchSelected: string;
  readonly matchingBracket: string;
  /** Tooltips, search panel and fold placeholders. */
  readonly panel: string;
  readonly caret: string;
  /** Text colour for punctuation and brackets (dimmer than `foreground`, still ≥4.5:1). */
  readonly punctuation: string;
  /** Line numbers. */
  readonly gutter: string;
}

export const THEME_PALETTES: readonly ThemePalette[] = [
  {
    id: "slate",
    appearance: "dark",
    background: "#111419",
    foreground: "#e1e5eb",
    tokens: {
      keyword: "#cba1fa",
      string: "#7cd591",
      comment: "#8997a8",
      number: "#fda669",
      type: "#e3d372",
      function: "#86bafd",
      variable: "#d6d1fe",
      property: "#65d0dc",
      operator: "#6db2b6",
      tag: "#fb979a",
      attribute: "#f9add0",
      regexp: "#73ecbc",
      invalid: "#fc463c",
    },
  },
  {
    id: "graphite",
    appearance: "dark",
    background: "#1b1916",
    foreground: "#e1ded7",
    tokens: {
      keyword: "#fe9fa6",
      string: "#bbc75f",
      comment: "#9c9488",
      number: "#b0b7ff",
      type: "#73dfdf",
      function: "#eec469",
      variable: "#efd3ac",
      property: "#6ec3eb",
      operator: "#c6a78f",
      tag: "#eb8ec4",
      attribute: "#f0ad7f",
      regexp: "#79dbb2",
      invalid: "#fe6652",
    },
  },
  {
    id: "paper",
    appearance: "light",
    background: "#fbfaf7",
    foreground: "#20242b",
    tokens: {
      keyword: "#7328ae",
      string: "#046a2f",
      comment: "#5a6472",
      number: "#9c4700",
      type: "#6f5305",
      function: "#0b58bb",
      variable: "#36354c",
      property: "#0b6a73",
      operator: "#1c4b4b",
      tag: "#b52f4e",
      attribute: "#9e366f",
      regexp: "#047460",
      invalid: "#980800",
    },
  },
  {
    id: "sand",
    appearance: "light",
    background: "#f5f0e4",
    foreground: "#2f271e",
    tokens: {
      keyword: "#a21921",
      string: "#015e28",
      comment: "#6e6150",
      number: "#5847b7",
      type: "#016566",
      function: "#735104",
      variable: "#423527",
      property: "#006086",
      operator: "#59392e",
      tag: "#a12d79",
      attribute: "#964d09",
      regexp: "#036f4f",
      invalid: "#bb0a00",
    },
  },
];

/** Backgrounds drawn behind text are mixed from theme colours so they stay in the same family. */
export function themeSurfaces(palette: ThemePalette): ThemeSurfaces {
  const { background: bg, foreground: fg, tokens } = palette;
  const dark = palette.appearance === "dark";
  return {
    selection: mix(tokens.function, bg, dark ? 0.26 : 0.2),
    activeLine: mix(fg, bg, dark ? 0.06 : 0.05),
    selectionMatch: mix(tokens.number, bg, dark ? 0.2 : 0.16),
    searchMatch: mix(tokens.type, bg, dark ? 0.26 : 0.22),
    searchMatchSelected: mix(tokens.number, bg, dark ? 0.4 : 0.32),
    matchingBracket: mix(fg, bg, dark ? 0.2 : 0.14),
    panel: mix(fg, bg, dark ? 0.07 : 0.045),
    caret: fg,
    punctuation: mix(fg, bg, 0.78),
    gutter: tokens.comment,
  };
}
