import { describe, expect, it } from "vitest";
import { detectPlatform, isAltGraph, keyLabelsFor } from "./platform";

describe("detectPlatform", () => {
  it("tells Apple devices, Windows and the rest apart", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "iPad" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ platform: "", userAgentData: { platform: "Windows" } })).toBe(
      "windows",
    );
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });
});

describe("keyLabelsFor", () => {
  it("uses symbols on a Mac and names elsewhere", () => {
    expect(keyLabelsFor("mac")).toEqual({ mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" });
    expect(keyLabelsFor("windows")).toEqual({
      mod: "Ctrl",
      ctrl: "Ctrl",
      alt: "Alt",
      shift: "Shift",
    });
    expect(keyLabelsFor("other").mod).toBe("Ctrl");
  });
});

describe("isAltGraph", () => {
  it("reads the AltGraph modifier", () => {
    expect(isAltGraph({ getModifierState: (key) => key === "AltGraph" })).toBe(true);
    expect(isAltGraph({ getModifierState: () => false })).toBe(false);
  });
});
