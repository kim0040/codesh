import { closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  cursorGroupForwardWin,
  defaultKeymap,
  deleteGroupForwardWin,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectGroupForwardWin,
  selectLine,
  toggleComment,
} from "@codemirror/commands";
import { foldKeymap } from "@codemirror/language";
import {
  gotoLine,
  openSearchPanel,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { type Chord, SHORTCUTS, type ShortcutId } from "../../../lib/shortcuts";

/**
 * Key maps of the editor. CodeMirror's own maps already follow each OS (⌥←/→ and ⌘←/→ on a Mac,
 * Ctrl+←/→ and Home/End elsewhere, ⌘⌫ and ⌥⌫ deletions, ⌘-click versus Ctrl-click for extra
 * cursors); the few bindings below change or add to them. `lib/shortcuts.ts` lists every
 * binding the sheet shows, and keymaps.test.ts checks each of them is really bound here.
 */

/** "KeyK" -> "k", "BracketLeft" -> "[": the key names CodeMirror uses. */
function cmKey(code: string | undefined): string {
  const letter = /^Key([A-Z])$/.exec(code ?? "");
  if (letter?.[1]) return letter[1].toLowerCase();
  const names: Record<string, string> = {
    Comma: ",",
    Slash: "/",
    BracketLeft: "[",
    BracketRight: "]",
  };
  return names[code ?? ""] ?? code ?? "";
}

/** A chord as CodeMirror writes it; `Mod` is ⌘ on a Mac and Ctrl elsewhere. */
export function cmKeyName(chord: Chord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("Mod");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(cmKey(chord.code));
  return parts.join("-");
}

/** Binds `run` to every chord of the shortcut, per platform: `mac`, `win` and the rest. */
function bindShortcut(
  id: ShortcutId,
  run: Command,
  options: { scope?: string; only?: "mac" | "pc" } = {},
): KeyBinding[] {
  const { mac, windows, other } = SHORTCUTS[id].chords;
  const bindings: KeyBinding[] = [];
  const count = Math.max(mac.length, windows.length, other.length);
  for (let i = 0; i < count; i++) {
    const binding: KeyBinding = { run, preventDefault: true, scope: options.scope };
    const m = mac[i];
    const w = windows[i];
    const o = other[i];
    if (options.only !== "pc" && m) binding.mac = cmKeyName(m);
    if (options.only !== "mac" && w) binding.win = cmKeyName(w);
    if (options.only !== "mac" && o) {
      // `key` would also apply on a Mac, so a Windows/Linux-only binding names its platforms.
      if (options.only === "pc") binding.linux = cmKeyName(o);
      else binding.key = cmKeyName(o);
    }
    if (binding.mac || binding.key || binding.win || binding.linux) bindings.push(binding);
  }
  return bindings;
}

/** Opens the search panel and puts the cursor in the replace field. */
export const openReplace: Command = (view) => {
  openSearchPanel(view);
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
  field?.focus();
  field?.select();
  return true;
};

/** What this app binds itself, ahead of CodeMirror's maps. */
export const appKeymap: readonly KeyBinding[] = [
  // Windows moves to the start of the next word on Ctrl+→ and deletes up to it on Ctrl+Delete;
  // macOS and Linux stop at the end of the word, which is CodeMirror's default.
  {
    win: "Mod-ArrowRight",
    run: cursorGroupForwardWin,
    shift: selectGroupForwardWin,
    preventDefault: true,
  },
  { win: "Mod-Delete", run: deleteGroupForwardWin, preventDefault: true },
  // Mac: ⌃G (Ctrl+Alt+G elsewhere is CodeMirror's own); ⌘⌥F / Ctrl+H open Replace.
  ...bindShortcut("goToLine", gotoLine, { only: "mac" }),
  ...bindShortcut("replace", openReplace, { scope: "editor search-panel" }),
  // Ctrl+Alt+K next to Ctrl+Shift+K, which Firefox keeps for its console.
  ...bindShortcut("deleteLine", deleteLine, { only: "pc" }),
];

/** Sublime Text habits, for people who pick that key map. */
export const sublimeKeymap: readonly KeyBinding[] = [
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

export const baseKeymap: readonly KeyBinding[] = [
  ...appKeymap,
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...searchKeymap,
  ...foldKeymap,
  { key: "Tab", run: indentMore, shift: indentLess },
];

/** Undo and redo go through Yjs's undo manager: it only undoes my own edits. */
export const undoKeymap: readonly KeyBinding[] = yUndoManagerKeymap;

/** Commands the palette offers for the people whose desktop takes the shortcut. */
export const editorCommands = {
  find: (view) => openSearchPanel(view),
  replace: (view) => openReplace(view),
  goToLine: (view) => gotoLine(view),
  addCursorAbove: (view) => addCursorAbove(view),
  addCursorBelow: (view) => addCursorBelow(view),
  selectMatches: (view) => selectSelectionMatches(view),
} as const satisfies Record<string, (view: EditorView) => boolean>;
