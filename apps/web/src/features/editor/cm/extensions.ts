import { closeBrackets } from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
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
import type { EditorPrefs, Keymap } from "../../../lib/prefs";
import { baseKeymap, sublimeKeymap, undoKeymap } from "./keymaps";
import { smoothCaret } from "./smooth-caret";

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
  prefs: Pick<EditorPrefs, "tabSize" | "indentWithTabs" | "wrap" | "smoothTyping">,
): Extension {
  return [
    EditorState.tabSize.of(prefs.tabSize),
    indentUnit.of(prefs.indentWithTabs ? "\t" : " ".repeat(prefs.tabSize)),
    prefs.wrap ? EditorView.lineWrapping : [],
    prefs.smoothTyping ? smoothCaret() : [],
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

const undoKeys = keymap.of(undoKeymap);

/** The bindings that need no extra chunk; vim and emacs fall back to these until theirs loads. */
export function plainKeymap(mode: Keymap): Extension {
  if (mode === "sublime") return [undoKeys, keymap.of([...sublimeKeymap, ...baseKeymap])];
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
        undoKeymap[index]?.run?.(cm.cm6);
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

/** Id of the visually hidden note that explains how to leave the editor with the keyboard. */
export const EDITOR_HINT_ID = "editor-hint";

/**
 * Marks focus that came from a click or a tap (`data-pointer-focus`), so the editor's focus ring
 * only shows for keyboard users, the way `:focus-visible` does for buttons (a contenteditable
 * always matches `:focus-visible`, so CSS alone cannot tell the two apart).
 */
function pointerFocus(): Extension {
  let pointer = false;
  return EditorView.domEventHandlers({
    mousedown() {
      pointer = true;
      return false;
    },
    focus(_event, view) {
      view.dom.toggleAttribute("data-pointer-focus", pointer);
      pointer = false;
      return false;
    },
    blur(_event, view) {
      view.dom.removeAttribute("data-pointer-focus");
      pointer = false;
      return false;
    },
  });
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
    pointerFocus(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.contentAttributes.of({
      "aria-label": ariaLabel,
      "aria-describedby": EDITOR_HINT_ID,
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
    }),
  ];
}
