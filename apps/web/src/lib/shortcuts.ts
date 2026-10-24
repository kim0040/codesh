import type { MessageKey } from "@codesh/i18n";
import { isImeKey } from "@codesh/ui";
import { keyLabelsFor, PLATFORM, type Platform } from "./platform";

/**
 * Every keyboard shortcut of the app, in one table. The handlers that listen for them, the
 * CodeMirror key maps, the labels on tooltips, menus and the palette, and the shortcut sheet are
 * all built from it, so a binding and the key cap that advertises it cannot drift apart.
 *
 * A chord is what the person presses. `mod` is ⌘ on a Mac and Ctrl elsewhere; `ctrl` is the
 * Control key itself (⌃ on a Mac, where it is not ⌘). Why the bindings differ per platform is
 * noted next to each entry; `docs/USER-GUIDE.md` §5.4 lists the result.
 */

export interface Chord {
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** `KeyboardEvent.code` of the key ("KeyK", "Comma", "ArrowUp"); see `keyMatches`. */
  code?: string;
  /** `KeyboardEvent.key` for keys that depend on Shift ("?"); no modifiers may be held. */
  key?: string;
}

export type ShortcutGroup = "general" | "editing" | "navigation";

export interface ShortcutDef {
  label: MessageKey;
  group: ShortcutGroup;
  /** Per platform: the first chord is the one shown, the others work too. */
  chords: Readonly<Record<Platform, readonly Chord[]>>;
  /**
   * Who handles it: the window (`useWindowShortcuts`), CodeMirror's key map, the mouse (listed
   * only), or one text field of its own (it never reaches the editor).
   */
  handler: "window" | "codemirror" | "pointer" | "field";
}

const everywhere = (...chords: Chord[]) => ({ mac: chords, windows: chords, other: chords });
const byOs = (mac: readonly Chord[], pc: readonly Chord[]) => ({
  mac,
  windows: pc,
  other: pc,
});

export const SHORTCUTS = {
  // ── Window-level: the app opens panels and runs actions ──────────
  /** Chrome, Firefox and Edge let a page take Ctrl+K from the address bar search; Safari has none. */
  palette: {
    label: "shortcuts.item.palette",
    group: "general",
    handler: "window",
    // F1 is for the Emacs keymap, which owns Ctrl+K (kill line) on Windows and Linux.
    chords: everywhere({ mod: true, code: "KeyK" }, { code: "F1" }),
  },
  shortcuts: {
    label: "shortcuts.item.shortcuts",
    group: "general",
    handler: "window",
    chords: everywhere({ key: "?" }),
  },
  // ⌘⌥ is taken on a Mac: ⌘⌥H hides other apps, ⌘⌥M minimises all windows, ⌘⌥C and ⌘⌥I are
  // the browsers' inspector. ⌃⌘ is free there. On Windows and Linux Ctrl+Shift+letter belongs
  // to Firefox and Edge devtools, so those use Ctrl+Alt.
  share: {
    label: "shortcuts.item.share",
    group: "general",
    handler: "window",
    chords: byOs(
      [{ ctrl: true, mod: true, code: "KeyS" }],
      [{ mod: true, alt: true, code: "KeyS" }],
    ),
  },
  settings: {
    label: "shortcuts.item.settings",
    group: "general",
    handler: "window",
    chords: everywhere({ mod: true, code: "Comma" }),
  },
  comments: {
    label: "shortcuts.item.comment",
    group: "general",
    handler: "window",
    chords: byOs(
      [{ ctrl: true, mod: true, code: "KeyM" }],
      [{ mod: true, alt: true, code: "KeyM" }],
    ),
  },
  history: {
    label: "shortcuts.item.history",
    group: "general",
    handler: "window",
    chords: byOs(
      [{ ctrl: true, mod: true, code: "KeyH" }],
      [{ mod: true, alt: true, code: "KeyH" }],
    ),
  },
  copyAll: {
    label: "shortcuts.item.copyAll",
    group: "editing",
    handler: "window",
    chords: byOs(
      [{ ctrl: true, mod: true, code: "KeyC" }],
      [{ mod: true, alt: true, code: "KeyC" }],
    ),
  },
  // Option+F types "ƒ" on a Mac: the key is matched by its code and the keydown is cancelled.
  format: {
    label: "shortcuts.item.format",
    group: "editing",
    handler: "window",
    chords: everywhere({ shift: true, alt: true, code: "KeyF" }),
  },
  postComment: {
    label: "shortcuts.item.postComment",
    group: "editing",
    handler: "field",
    chords: everywhere({ mod: true, code: "Enter" }),
  },

  // ── Editor: CodeMirror key maps (apps/web/src/features/editor/cm/extensions.ts) ──
  find: {
    label: "shortcuts.item.find",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, code: "KeyF" }),
  },
  findNext: {
    label: "shortcuts.item.findNext",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, code: "KeyG" }, { code: "F3" }),
  },
  // Ctrl+H is Replace on Windows and Linux editors; ⌘⌥F is the Mac convention.
  replace: {
    label: "shortcuts.item.replace",
    group: "editing",
    handler: "codemirror",
    chords: byOs([{ mod: true, alt: true, code: "KeyF" }], [{ mod: true, code: "KeyH" }]),
  },
  // Ctrl+G is "find next" on Windows and Linux, so Go to line keeps CodeMirror's Ctrl+Alt+G
  // there; on a Mac ⌃G (Sublime, Xcode) is free.
  goToLine: {
    label: "shortcuts.item.goToLine",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ ctrl: true, code: "KeyG" }], [{ mod: true, alt: true, code: "KeyG" }]),
  },
  selectNext: {
    label: "shortcuts.item.selectNext",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, code: "KeyD" }),
  },
  selectMatches: {
    label: "shortcuts.item.selectMatches",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, shift: true, code: "KeyL" }),
  },
  // Ctrl+Alt+↑/↓ switches workspaces on GNOME, KDE and Cinnamon: the palette has the same two
  // commands for those desktops.
  addCursorAbove: {
    label: "shortcuts.item.addCursorAbove",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, alt: true, code: "ArrowUp" }),
  },
  addCursorBelow: {
    label: "shortcuts.item.addCursorBelow",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, alt: true, code: "ArrowDown" }),
  },
  moveLineUp: {
    label: "shortcuts.item.moveLine",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ alt: true, code: "ArrowUp" }),
  },
  moveLineDown: {
    label: "shortcuts.item.moveLine",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ alt: true, code: "ArrowDown" }),
  },
  copyLineDown: {
    label: "shortcuts.item.copyLine",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ shift: true, alt: true, code: "ArrowDown" }),
  },
  // Firefox gives Ctrl+Shift+K to its console; Ctrl+Alt+K is the same command there.
  deleteLine: {
    label: "shortcuts.item.deleteLine",
    group: "editing",
    handler: "codemirror",
    chords: byOs(
      [{ mod: true, shift: true, code: "KeyK" }],
      [
        { mod: true, shift: true, code: "KeyK" },
        { mod: true, alt: true, code: "KeyK" },
      ],
    ),
  },
  toggleComment: {
    label: "shortcuts.item.toggleComment",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, code: "Slash" }),
  },
  indentMore: {
    label: "shortcuts.item.indent",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ code: "Tab" }, { mod: true, code: "BracketRight" }),
  },
  indentLess: {
    label: "shortcuts.item.indent",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ shift: true, code: "Tab" }, { mod: true, code: "BracketLeft" }),
  },
  fold: {
    label: "shortcuts.item.fold",
    group: "editing",
    handler: "codemirror",
    chords: byOs(
      [{ mod: true, alt: true, code: "BracketLeft" }],
      [{ ctrl: true, shift: true, code: "BracketLeft" }],
    ),
  },
  unfold: {
    label: "shortcuts.item.fold",
    group: "editing",
    handler: "codemirror",
    chords: byOs(
      [{ mod: true, alt: true, code: "BracketRight" }],
      [{ ctrl: true, shift: true, code: "BracketRight" }],
    ),
  },
  undo: {
    label: "shortcuts.item.undo",
    group: "editing",
    handler: "codemirror",
    chords: everywhere({ mod: true, code: "KeyZ" }),
  },
  redo: {
    label: "shortcuts.item.redo",
    group: "editing",
    handler: "codemirror",
    chords: byOs(
      [{ mod: true, shift: true, code: "KeyZ" }],
      [
        { mod: true, code: "KeyY" },
        { mod: true, shift: true, code: "KeyZ" },
      ],
    ),
  },

  // ── Moving and deleting by word and line: the habits of each OS ──
  wordLeft: {
    label: "shortcuts.item.wordMove",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ alt: true, code: "ArrowLeft" }], [{ mod: true, code: "ArrowLeft" }]),
  },
  wordRight: {
    label: "shortcuts.item.wordMove",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ alt: true, code: "ArrowRight" }], [{ mod: true, code: "ArrowRight" }]),
  },
  lineStart: {
    label: "shortcuts.item.lineEnds",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ mod: true, code: "ArrowLeft" }], [{ code: "Home" }]),
  },
  lineEnd: {
    label: "shortcuts.item.lineEnds",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ mod: true, code: "ArrowRight" }], [{ code: "End" }]),
  },
  docStart: {
    label: "shortcuts.item.docEnds",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ mod: true, code: "ArrowUp" }], [{ mod: true, code: "Home" }]),
  },
  docEnd: {
    label: "shortcuts.item.docEnds",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ mod: true, code: "ArrowDown" }], [{ mod: true, code: "End" }]),
  },
  deleteWordBack: {
    label: "shortcuts.item.deleteWord",
    group: "navigation",
    handler: "codemirror",
    chords: byOs([{ alt: true, code: "Backspace" }], [{ mod: true, code: "Backspace" }]),
  },

  // ── Mouse ────────────────────────────────────────────────────────
  // Control-click is the context menu on a Mac, so only ⌘-click adds a cursor there.
  addCursorClick: {
    label: "shortcuts.item.addCursorClick",
    group: "editing",
    handler: "pointer",
    chords: everywhere({ mod: true, code: "Click" }),
  },
  // Many Linux window managers move the window on Alt+drag; adding Shift avoids that.
  rectangleSelect: {
    label: "shortcuts.item.rectangleSelect",
    group: "editing",
    handler: "pointer",
    chords: everywhere({ alt: true, code: "Drag" }),
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export function chordsFor(id: ShortcutId, platform: Platform = PLATFORM): readonly Chord[] {
  return SHORTCUTS[id].chords[platform];
}

// ── Labels ──────────────────────────────────────────────────────────

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Drag: "drag",
  Click: "click",
};

const MAC_KEY_NAMES: Readonly<Record<string, string>> = {
  Backspace: "⌫",
  Enter: "↩",
};

function keyName(chord: Chord, platform: Platform): string {
  if (chord.key) return chord.key;
  const code = chord.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  if (platform === "mac" && MAC_KEY_NAMES[code]) return MAC_KEY_NAMES[code];
  return KEY_NAMES[code] ?? code;
}

/**
 * Key caps of a chord in the order the platform writes them: ⌃ ⌥ ⇧ ⌘ on a Mac (Apple's order),
 * Ctrl Alt Shift elsewhere.
 */
export function chordKeys(chord: Chord, platform: Platform = PLATFORM): string[] {
  const names = keyLabelsFor(platform);
  const keys: string[] = [];
  const ctrl = chord.ctrl || (chord.mod && platform !== "mac");
  const meta = chord.mod && platform === "mac";
  if (ctrl) keys.push(names.ctrl);
  if (chord.alt) keys.push(names.alt);
  if (chord.shift) keys.push(names.shift);
  if (meta) keys.push(names.mod);
  keys.push(keyName(chord, platform));
  return keys;
}

/** Key caps of the shortcut's main chord for a tooltip, menu item or palette row. */
export function shortcutKeys(id: ShortcutId, platform: Platform = PLATFORM): string[] {
  const [chord] = chordsFor(id, platform);
  return chord ? chordKeys(chord, platform) : [];
}

// ── Matching ────────────────────────────────────────────────────────

type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
> &
  Partial<Pick<KeyboardEvent, "getModifierState" | "isComposing" | "keyCode">>;

/** "KeyK" -> "k", "Comma" -> ","; null for keys that have no character. */
function charOf(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1].toLowerCase();
  if (code === "Comma") return ",";
  return null;
}

/**
 * Whether the pressed key is the chord's key. On a Latin layout the character wins, so Dvorak and
 * AZERTY users get the letter printed on their keys. Where the character is not usable (Korean
 * layout gives "ㅏ" for K, Option+F gives "ƒ" on a Mac, dead keys) the physical key decides.
 */
function keyMatches(chord: Chord, event: KeyEventLike): boolean {
  if (chord.key) return event.key === chord.key;
  const code = chord.code ?? "";
  const want = charOf(code);
  const got = event.key;
  if (want && got.length === 1 && got.charCodeAt(0) < 128 && /[a-z,]/i.test(got)) {
    return got.toLowerCase() === want;
  }
  return event.code === code || (code === "Enter" && event.code === "NumpadEnter");
}

export function matchesChord(
  chord: Chord,
  event: KeyEventLike,
  platform: Platform = PLATFORM,
): boolean {
  // AltGr (Ctrl+Alt on Windows) types characters on many layouts; it is never a shortcut.
  if (event.getModifierState?.("AltGraph")) return false;
  const wantMeta = Boolean(chord.mod) && platform === "mac";
  const wantCtrl = Boolean(chord.ctrl) || (Boolean(chord.mod) && platform !== "mac");
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== Boolean(chord.alt)) return false;
  // "?" is typed with Shift on most layouts, so Shift only counts for chords that name it.
  if (!chord.key && event.shiftKey !== Boolean(chord.shift)) return false;
  return keyMatches(chord, event);
}

export function matchesShortcut(
  event: KeyEventLike,
  id: ShortcutId,
  platform: Platform = PLATFORM,
): boolean {
  return chordsFor(id, platform).some((chord) => matchesChord(chord, event, platform));
}

/** Keys that belong to an input method (a Korean syllable being typed) never run a shortcut. */
export function isComposing(event: KeyEventLike): boolean {
  return isImeKey(event);
}

/** The first window-level shortcut of `ids` that this key press is, if any. */
export function shortcutOf<Id extends ShortcutId>(
  event: KeyEventLike,
  ids: readonly Id[],
  platform: Platform = PLATFORM,
): Id | null {
  if (isComposing(event)) return null;
  return ids.find((id) => matchesShortcut(event, id, platform)) ?? null;
}
