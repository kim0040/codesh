import { describe, expect, it } from "vitest";
import { isImeKey } from "./ime";

describe("isImeKey", () => {
  it("is true while composing", () => {
    expect(isImeKey({ isComposing: true, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("catches Safari's Enter after compositionend (keyCode 229, isComposing false)", () => {
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("is false for ordinary keys and for chords that carry the legacy 229 code", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({ keyCode: 75, ctrlKey: true })).toBe(false);
    expect(isImeKey({ isComposing: false, keyCode: 229, metaKey: true })).toBe(false);
    expect(isImeKey({})).toBe(false);
  });
});
