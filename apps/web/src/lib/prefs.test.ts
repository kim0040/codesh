import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getPrefs,
  resetPrefs,
  sanitizePrefs,
  setPrefs,
} from "./prefs";

describe("sanitizePrefs", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const input of [null, undefined, "text", 5, []]) {
      expect(sanitizePrefs(input)).toEqual(DEFAULT_PREFS);
    }
  });

  it("clamps numbers and rounds them", () => {
    expect(sanitizePrefs({ fontSize: 3 }).fontSize).toBe(FONT_SIZE_MIN);
    expect(sanitizePrefs({ fontSize: 99 }).fontSize).toBe(FONT_SIZE_MAX);
    expect(sanitizePrefs({ fontSize: 15.6 }).fontSize).toBe(16);
    expect(sanitizePrefs({ tabSize: 0 }).tabSize).toBe(1);
    expect(sanitizePrefs({ tabSize: Number.NaN }).tabSize).toBe(DEFAULT_PREFS.tabSize);
  });

  it("drops values of the wrong type or outside the known sets", () => {
    const result = sanitizePrefs({
      keymap: "nano",
      editorTheme: "neon",
      wrap: "yes",
      lineNumbers: 0,
    });
    expect(result.keymap).toBe("default");
    expect(result.editorTheme).toBe("auto");
    expect(result.wrap).toBe(DEFAULT_PREFS.wrap);
    expect(result.lineNumbers).toBe(DEFAULT_PREFS.lineNumbers);
  });

  it("keeps valid values", () => {
    const stored = { ...DEFAULT_PREFS, keymap: "vim", wrap: false, fontSize: 18, tabSize: 4 };
    expect(sanitizePrefs(stored)).toEqual(stored);
  });
});

describe("setPrefs", () => {
  it("merges a patch, validates it and can be reset", () => {
    resetPrefs();
    setPrefs({ fontSize: 400, keymap: "emacs" });
    expect(getPrefs().fontSize).toBe(FONT_SIZE_MAX);
    expect(getPrefs().keymap).toBe("emacs");
    expect(getPrefs().wrap).toBe(DEFAULT_PREFS.wrap);
    resetPrefs();
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });
});
