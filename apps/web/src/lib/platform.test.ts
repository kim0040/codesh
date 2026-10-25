import { describe, expect, it } from "vitest";
import { detectPlatform, isAltGraph, isIos, keyLabelsFor } from "./platform";

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

describe("isIos", () => {
  it("recognizes iPhone and iPadOS in every browser", () => {
    expect(
      isIos({
        platform: "iPhone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari/604.1",
      }),
    ).toBe(true);
    expect(
      isIos({
        platform: "MacIntel",
        maxTouchPoints: 5,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Version/18.0 Safari/605.1",
      }),
    ).toBe(true);
    expect(
      isIos({
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone) AppleWebKit CriOS/130.0 Mobile Safari/604.1",
      }),
    ).toBe(true);
    expect(
      isIos({
        platform: "MacIntel",
        maxTouchPoints: 0,
        userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit Version/18.0 Safari/605.1",
      }),
    ).toBe(false);
    expect(
      isIos({
        platform: "Linux armv8l",
        userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit Chrome/130.0 Safari/537.36",
      }),
    ).toBe(false);
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
