/*
 * CodeMirror themes: two dark (slate, graphite) and two light (paper, sand).
 * Each theme is an `EditorView.theme` (chrome) plus a `HighlightStyle` (syntax). Colours come from
 * `theme-colors.ts`; this file only maps them to CodeMirror selectors and Lezer tags.
 *
 * Meaning never relies on colour alone: comments are italic, keywords are weight 500, invalid code
 * has a wavy underline, and headings, emphasis, links and diffs carry weight, slant or decoration.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import {
  THEME_PALETTES,
  type ThemeId,
  type ThemePalette,
  type ThemeSurfaces,
  type TokenName,
  themeSurfaces,
} from "./theme-colors.js";

export type { ThemeId, TokenName } from "./theme-colors.js";
export { TOKEN_NAMES } from "./theme-colors.js";

export interface EditorTheme {
  readonly id: ThemeId;
  readonly appearance: "dark" | "light";
  readonly background: string;
  readonly foreground: string;
  readonly selection: string;
  readonly tokens: Readonly<Record<TokenName, string>>;
  /** Colours drawn behind or beside text, for contrast checks and for UI that wants to match. */
  readonly surfaces: ThemeSurfaces;
  /** Editor chrome + syntax highlighting, ready for `EditorState.create({ extensions })`. */
  readonly extension: Extension;
  /** The syntax part alone, for static rendering of code (previews, HTML export). */
  readonly highlightStyle: HighlightStyle;
}

export const KEYWORD_WEIGHT = "500";

export function createHighlightStyle(
  palette: ThemePalette,
  surfaces: ThemeSurfaces,
): HighlightStyle {
  const c = palette.tokens;
  return HighlightStyle.define([
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.operatorKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.modifier,
        t.self,
        t.null,
      ],
      color: c.keyword,
      fontWeight: KEYWORD_WEIGHT,
    },
    { tag: [t.string, t.character, t.docString, t.special(t.string)], color: c.string },
    { tag: [t.regexp, t.escape], color: c.regexp },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: c.comment,
      fontStyle: "italic",
    },
    { tag: [t.number, t.integer, t.float, t.bool, t.atom, t.constant(t.name)], color: c.number },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: c.type },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.definition(t.function(t.variableName)),
        t.macroName,
      ],
      color: c.function,
    },
    {
      tag: [t.variableName, t.local(t.variableName), t.definition(t.variableName), t.labelName],
      color: c.variable,
    },
    { tag: [t.propertyName, t.definition(t.propertyName)], color: c.property },
    {
      tag: [
        t.operator,
        t.arithmeticOperator,
        t.logicOperator,
        t.bitwiseOperator,
        t.compareOperator,
        t.updateOperator,
        t.definitionOperator,
        t.typeOperator,
        t.controlOperator,
      ],
      color: c.operator,
    },
    {
      tag: [
        t.punctuation,
        t.separator,
        t.bracket,
        t.paren,
        t.squareBracket,
        t.angleBracket,
        t.brace,
        t.derefOperator,
      ],
      color: surfaces.punctuation,
    },
    { tag: t.tagName, color: c.tag },
    { tag: t.attributeName, color: c.attribute },
    { tag: t.attributeValue, color: c.string },
    { tag: [t.annotation, t.meta, t.processingInstruction, t.documentMeta], color: c.attribute },
    { tag: t.invalid, color: c.invalid, textDecoration: "underline wavy" },
    // Markdown, links and diffs.
    { tag: [t.heading, t.heading1, t.heading2], color: c.function, fontWeight: "650" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: c.function, fontWeight: "600" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.link, color: c.property, textDecoration: "underline" },
    { tag: t.url, color: c.string, textDecoration: "underline" },
    { tag: t.quote, color: c.comment, fontStyle: "italic" },
    { tag: t.list, color: c.operator },
    { tag: t.monospace, color: c.string },
    { tag: t.contentSeparator, color: c.comment },
    { tag: t.inserted, color: c.string },
    { tag: t.deleted, color: c.invalid },
    { tag: t.changed, color: c.number },
  ]);
}

export function createChromeTheme(palette: ThemePalette, surfaces: ThemeSurfaces): Extension {
  const { background, foreground, tokens } = palette;
  return EditorView.theme(
    {
      "&": { color: foreground, backgroundColor: background },
      ".cm-scroller": {
        fontFamily: 'var(--font-mono, "JetBrains Mono Variable", ui-monospace, monospace)',
      },
      ".cm-content": { caretColor: surfaces.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: surfaces.caret, borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: surfaces.selection },
      ".cm-selectionMatch": { backgroundColor: surfaces.selectionMatch },
      ".cm-activeLine": { backgroundColor: surfaces.activeLine },
      "&.cm-focused .cm-matchingBracket": {
        backgroundColor: surfaces.matchingBracket,
        outline: `1px solid ${surfaces.gutter}`,
      },
      "&.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: surfaces.matchingBracket,
        outline: `1px solid ${tokens.invalid}`,
      },
      ".cm-gutters": {
        backgroundColor: background,
        color: surfaces.gutter,
        border: "none",
      },
      ".cm-activeLineGutter": { backgroundColor: surfaces.activeLine, color: foreground },
      ".cm-foldPlaceholder": {
        backgroundColor: surfaces.panel,
        color: foreground,
        border: `1px solid ${surfaces.gutter}`,
      },
      ".cm-tooltip": {
        backgroundColor: surfaces.panel,
        color: foreground,
        border: `1px solid ${surfaces.gutter}`,
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: surfaces.selection,
        color: foreground,
      },
      ".cm-panels": { backgroundColor: surfaces.panel, color: foreground },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${surfaces.gutter}` },
      ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${surfaces.gutter}` },
      ".cm-searchMatch": {
        backgroundColor: surfaces.searchMatch,
        outline: `1px solid ${tokens.type}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: surfaces.searchMatchSelected },
    },
    { dark: palette.appearance === "dark" },
  );
}

function createTheme(palette: ThemePalette): EditorTheme {
  const surfaces = themeSurfaces(palette);
  const highlightStyle = createHighlightStyle(palette, surfaces);
  return {
    id: palette.id,
    appearance: palette.appearance,
    background: palette.background,
    foreground: palette.foreground,
    selection: surfaces.selection,
    tokens: palette.tokens,
    surfaces,
    highlightStyle,
    extension: [createChromeTheme(palette, surfaces), syntaxHighlighting(highlightStyle)],
  };
}

export const EDITOR_THEMES: readonly EditorTheme[] = THEME_PALETTES.map(createTheme);

export const DEFAULT_THEME_ID: Record<"dark" | "light", ThemeId> = {
  dark: "slate",
  light: "paper",
};

export function getEditorTheme(id: ThemeId): EditorTheme {
  const theme = EDITOR_THEMES.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`unknown editor theme "${id}"`);
  return theme;
}

export function isThemeId(value: unknown): value is ThemeId {
  return EDITOR_THEMES.some((theme) => theme.id === value);
}
