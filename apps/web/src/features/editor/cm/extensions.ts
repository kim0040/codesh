import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  copyLineDown,
  defaultKeymap,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectLine,
  toggleComment,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap, selectNextOccurrence } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { getEditorTheme, type ThemeId } from "@codesh/highlight";
import { yUndoManagerKeymap } from "y-codemirror.next";
import type { EditorPrefs, Keymap } from "../../../lib/prefs";

/** Pure builders for the editor's reconfigurable parts; EditorPane puts each in a Compartment. */

export function themeExtension(id: ThemeId): Extension {
  return getEditorTheme(id).extension;
}

export function fontExtension(size: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${size}px` },
    ".cm-scroller": { lineHeight: "1.6" },
    ".cm-gutters": { fontSize: `${Math.max(10, size - 1)}px` },
  });
}

export function editingExtension(
  prefs: Pick<EditorPrefs, "tabSize" | "indentWithTabs" | "wrap">,
): Extension {
  return [
    EditorState.tabSize.of(prefs.tabSize),
    indentUnit.of(prefs.indentWithTabs ? "\t" : " ".repeat(prefs.tabSize)),
    prefs.wrap ? EditorView.lineWrapping : [],
  ];
}

export function gutterExtension(lineNumbersOn: boolean): Extension {
  return lineNumbersOn ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : [];
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return EditorState.readOnly.of(readOnly);
}

export function languageExtension(support: LanguageSupport | null): Extension {
  return support ?? [];
}

const sublimeKeys = [
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Mod-Shift-k", run: deleteLine },
  { key: "Mod-Shift-d", run: copyLineDown },
  { key: "Mod-l", run: selectLine },
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-]", run: indentMore },
  { key: "Mod-[", run: indentLess },
];

const baseKeymap = [
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...searchKeymap,
  ...foldKeymap,
  { key: "Tab", run: indentMore, shift: indentLess },
];

const undoKeys = keymap.of(yUndoManagerKeymap);

/** The bindings that need no extra chunk; vim and emacs fall back to these until theirs loads. */
export function plainKeymap(mode: Keymap): Extension {
  if (mode === "sublime") return [undoKeys, keymap.of([...sublimeKeys, ...baseKeymap])];
  return [undoKeys, keymap.of(baseKeymap)];
}

/**
 * Key bindings. Undo and redo go through Yjs's undo manager (it only undoes my own edits), not
 * CodeMirror's history. Vim and Emacs are separate chunks loaded on demand.
 */
export async function keymapExtension(mode: Keymap): Promise<Extension> {
  if (mode === "vim") {
    const { vim, Vim } = await import("@replit/codemirror-vim");
    try {
      // `u` and Ctrl-R would call CodeMirror's history, which is not installed.
      const run = (index: number) => (cm: { cm6: EditorView }) => {
        yUndoManagerKeymap[index]?.run?.(cm.cm6);
      };
      Vim.defineAction("codeshUndo", run(0) as never);
      Vim.defineAction("codeshRedo", run(1) as never);
      Vim.mapCommand("u", "action", "codeshUndo", {}, { context: "normal" });
      Vim.mapCommand("<C-r>", "action", "codeshRedo", {}, { context: "normal" });
    } catch {
      // The editor still works; only undo from normal mode is affected.
    }
    return [vim(), undoKeys, keymap.of(baseKeymap)];
  }
  if (mode === "emacs") {
    const { emacs } = await import("@replit/codemirror-emacs");
    return [emacs(), undoKeys, keymap.of(baseKeymap)];
  }
  return plainKeymap(mode);
}

/** Always-on behaviour that does not depend on preferences. */
export function baseExtensions(ariaLabel: string): Extension {
  return [
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.contentAttributes.of({
      "aria-label": ariaLabel,
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
    }),
  ];
}
