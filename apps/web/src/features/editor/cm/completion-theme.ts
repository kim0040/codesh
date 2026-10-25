import { EditorView } from "@codemirror/view";
import type { EditorTheme } from "@codesh/highlight";

/** Popup chrome uses the active editor theme and keeps the selected row high contrast. */
export function completionTheme(theme: EditorTheme) {
  const selectedBackground = theme.appearance === "dark" ? "#39435c" : "#dce8fa";
  const selectedForeground = theme.appearance === "dark" ? "#f8fbff" : "#172033";
  return EditorView.theme({
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: theme.surfaces.panel,
      color: theme.foreground,
      border: `1px solid ${theme.surfaces.selection}`,
      borderRadius: "0.5rem",
      boxShadow: "0 8px 24px rgb(0 0 0 / 22%)",
      maxWidth: "min(25rem, calc(100vw - 1rem))",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete ul": {
      boxSizing: "border-box",
      maxHeight: "min(24rem, 60vh)",
      maxWidth: "100%",
      overflow: "auto",
      padding: "0.25rem",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
    },
    ".cm-tooltip-autocomplete li": {
      boxSizing: "border-box",
      minHeight: "2.75rem",
      maxWidth: "100%",
      overflow: "hidden",
      padding: "0.5rem 0.625rem",
      borderRadius: "0.25rem",
      color: theme.foreground,
    },
    ".cm-tooltip-autocomplete li[aria-selected]": {
      backgroundColor: selectedBackground,
      color: selectedForeground,
      boxShadow: `inset 2px 0 ${theme.tokens.function}`,
    },
    ".cm-completionLabel": {
      display: "inline-block",
      maxWidth: "100%",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
    },
    ".cm-completionDetail": {
      marginInlineStart: "0.75rem",
      color: theme.foreground,
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)",
    },
  });
}
