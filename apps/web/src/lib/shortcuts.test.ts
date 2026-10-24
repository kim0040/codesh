import { describe, expect, it } from "vitest";
import type { Platform } from "./platform";
import {
  chordKeys,
  matchesShortcut,
  SHORTCUTS,
  type ShortcutId,
  shortcutKeys,
  shortcutOf,
} from "./shortcuts";

const PLATFORMS: Platform[] = ["mac", "windows", "other"];

interface Press {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  altGraph?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** A keydown as the browser reports it. */
function press(p: Press) {
  return {
    key: p.key,
    code: p.code,
    ctrlKey: p.ctrlKey ?? false,
    metaKey: p.metaKey ?? false,
    altKey: p.altKey ?? false,
    shiftKey: p.shiftKey ?? false,
    isComposing: p.isComposing ?? false,
    keyCode: p.keyCode ?? 0,
    getModifierState: (name: string) => name === "AltGraph" && Boolean(p.altGraph),
  };
}

describe("labels", () => {
  it("writes Apple's order with ⌃ and ⌘ as different keys on a Mac", () => {
    expect(shortcutKeys("palette", "mac")).toEqual(["⌘", "K"]);
    expect(shortcutKeys("share", "mac")).toEqual(["⌃", "⌘", "S"]);
    expect(shortcutKeys("format", "mac")).toEqual(["⌥", "⇧", "F"]);
    expect(shortcutKeys("settings", "mac")).toEqual(["⌘", ","]);
    expect(shortcutKeys("goToLine", "mac")).toEqual(["⌃", "G"]);
  });

  it("names the keys on Windows and Linux", () => {
    for (const platform of ["windows", "other"] as const) {
      expect(shortcutKeys("palette", platform)).toEqual(["Ctrl", "K"]);
      expect(shortcutKeys("share", platform)).toEqual(["Ctrl", "Alt", "S"]);
      expect(shortcutKeys("format", platform)).toEqual(["Alt", "Shift", "F"]);
      expect(shortcutKeys("goToLine", platform)).toEqual(["Ctrl", "Alt", "G"]);
    }
  });

  it("follows each OS for moving, deleting and redoing", () => {
    expect(shortcutKeys("wordLeft", "mac")).toEqual(["⌥", "←"]);
    expect(shortcutKeys("wordLeft", "windows")).toEqual(["Ctrl", "←"]);
    expect(shortcutKeys("lineStart", "mac")).toEqual(["⌘", "←"]);
    expect(shortcutKeys("lineStart", "other")).toEqual(["Home"]);
    expect(shortcutKeys("deleteWordBack", "mac")).toEqual(["⌥", "⌫"]);
    expect(shortcutKeys("deleteWordBack", "windows")).toEqual(["Ctrl", "Backspace"]);
    expect(shortcutKeys("redo", "mac")).toEqual(["⇧", "⌘", "Z"]);
    expect(shortcutKeys("redo", "windows")).toEqual(["Ctrl", "Y"]);
  });

  it("has a main chord for every shortcut on every platform", () => {
    for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
      for (const platform of PLATFORMS) {
        expect(
          chordKeys(SHORTCUTS[id].chords[platform][0] ?? {}, platform).length,
          id,
        ).toBeGreaterThan(0);
        expect(SHORTCUTS[id].chords[platform].length, `${id} on ${platform}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("matching", () => {
  it("opens the palette with ⌘K on a Mac but not with Ctrl+K, which is the line-kill key there", () => {
    expect(
      matchesShortcut(press({ key: "k", code: "KeyK", metaKey: true }), "palette", "mac"),
    ).toBe(true);
    expect(
      matchesShortcut(press({ key: "k", code: "KeyK", ctrlKey: true }), "palette", "mac"),
    ).toBe(false);
  });

  it("uses Ctrl on Windows and Linux and ignores the Windows or Super key", () => {
    const ctrlK = press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesShortcut(ctrlK, "palette", "windows")).toBe(true);
    expect(matchesShortcut(ctrlK, "palette", "other")).toBe(true);
    expect(
      matchesShortcut(press({ key: "k", code: "KeyK", metaKey: true }), "palette", "windows"),
    ).toBe(false);
  });

  it("matches the Korean layout by key position", () => {
    const korean = press({ key: "ㅏ", code: "KeyK", metaKey: true });
    expect(matchesShortcut(korean, "palette", "mac")).toBe(true);
  });

  it("matches a Latin layout by the letter it prints (Dvorak puts K where QWERTY has V)", () => {
    expect(
      matchesShortcut(press({ key: "k", code: "KeyV", ctrlKey: true }), "palette", "windows"),
    ).toBe(true);
    expect(
      matchesShortcut(press({ key: "v", code: "KeyK", ctrlKey: true }), "palette", "windows"),
    ).toBe(false);
  });

  it("fires Shift+Option+F on a Mac although Option+Shift+F types Ï", () => {
    const optionShiftF = press({ key: "Ï", code: "KeyF", altKey: true, shiftKey: true });
    expect(matchesShortcut(optionShiftF, "format", "mac")).toBe(true);
    // Plain Option+F (ƒ) stays a typed character.
    expect(matchesShortcut(press({ key: "ƒ", code: "KeyF", altKey: true }), "format", "mac")).toBe(
      false,
    );
  });

  it("uses ⌃⌘ for the panels on a Mac and leaves ⌘⌥ to the browser and macOS", () => {
    const controlCommandH = press({ key: "h", code: "KeyH", ctrlKey: true, metaKey: true });
    expect(matchesShortcut(controlCommandH, "history", "mac")).toBe(true);
    const commandOptionH = press({ key: "˙", code: "KeyH", metaKey: true, altKey: true });
    expect(matchesShortcut(commandOptionH, "history", "mac")).toBe(false);
  });

  it("never treats AltGr as Ctrl+Alt", () => {
    const altGr = press({ key: "ś", code: "KeyS", ctrlKey: true, altKey: true, altGraph: true });
    expect(matchesShortcut(altGr, "share", "windows")).toBe(false);
    const realChord = press({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
    expect(matchesShortcut(realChord, "share", "windows")).toBe(true);
  });

  it("matches ? whichever way it is typed, but not with Ctrl or ⌘", () => {
    expect(
      matchesShortcut(press({ key: "?", code: "Slash", shiftKey: true }), "shortcuts", "windows"),
    ).toBe(true);
    expect(
      matchesShortcut(press({ key: "?", code: "Slash", ctrlKey: true }), "shortcuts", "windows"),
    ).toBe(false);
  });

  it("opens the palette with F1 on every platform (Emacs keeps Ctrl+K)", () => {
    for (const platform of PLATFORMS) {
      expect(matchesShortcut(press({ key: "F1", code: "F1" }), "palette", platform)).toBe(true);
    }
  });

  it("matches the comma on a Korean layout", () => {
    expect(
      matchesShortcut(press({ key: ",", code: "Comma", metaKey: true }), "settings", "mac"),
    ).toBe(true);
    expect(
      matchesShortcut(
        press({ key: ",", code: "Comma", metaKey: true, shiftKey: true }),
        "settings",
        "mac",
      ),
    ).toBe(false);
  });

  it("accepts the numpad Enter for posting a comment", () => {
    expect(
      matchesShortcut(
        press({ key: "Enter", code: "NumpadEnter", metaKey: true }),
        "postComment",
        "mac",
      ),
    ).toBe(true);
    expect(
      matchesShortcut(press({ key: "Enter", code: "Enter", ctrlKey: true }), "postComment", "mac"),
    ).toBe(false);
  });
});

describe("shortcutOf", () => {
  it("ignores keys that belong to an input method", () => {
    const composing = press({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      isComposing: true,
      keyCode: 229,
    });
    expect(shortcutOf(composing, ["palette"], "windows")).toBeNull();
    const ordinary = press({ key: "k", code: "KeyK", ctrlKey: true, keyCode: 75 });
    expect(shortcutOf(ordinary, ["palette"], "windows")).toBe("palette");
  });

  it("does not take ctrl+229 chords for composition (Korean IME gives them to the page)", () => {
    const chord = press({ key: "k", code: "KeyK", ctrlKey: true, keyCode: 229 });
    expect(shortcutOf(chord, ["palette"], "windows")).toBe("palette");
  });
});

describe("table", () => {
  /** A comparable form of the chord on one platform. */
  function signature(id: ShortcutId, platform: Platform): string[] {
    return SHORTCUTS[id].chords[platform].map((chord) => {
      const meta = chord.mod && platform === "mac";
      const ctrl = chord.ctrl || (chord.mod && platform !== "mac");
      return [
        meta && "meta",
        ctrl && "ctrl",
        chord.alt && "alt",
        chord.shift && "shift",
        chord.code ?? chord.key,
      ]
        .filter(Boolean)
        .join("+");
    });
  }

  it("gives no two window-level shortcuts the same keys", () => {
    const ids = (Object.keys(SHORTCUTS) as ShortcutId[]).filter(
      (id) => SHORTCUTS[id].handler === "window",
    );
    for (const platform of PLATFORMS) {
      const seen = new Map<string, ShortcutId>();
      for (const id of ids) {
        for (const sig of signature(id, platform)) {
          expect(
            seen.get(sig),
            `${platform}: ${sig} is both ${seen.get(sig)} and ${id}`,
          ).toBeUndefined();
          seen.set(sig, id);
        }
      }
    }
  });
});
