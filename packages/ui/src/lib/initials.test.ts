import { describe, expect, it } from "vitest";
import { participantSlot } from "../components/avatar.js";
import { initialsOf } from "./initials.js";

describe("initialsOf", () => {
  it("uses the first Hangul syllable", () => {
    expect(initialsOf("김현민")).toBe("김");
    expect(initialsOf("  박서연 ")).toBe("박");
  });

  it("uses up to two Latin initials", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("grace")).toBe("G");
    expect(initialsOf("linus_torvalds-jr")).toBe("LT");
  });

  it("falls back for empty names and keeps emoji whole", () => {
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("🦊 fox")).toBe("🦊F");
  });
});

describe("participantSlot", () => {
  it("is stable and within 1–12", () => {
    expect(participantSlot("user-42")).toBe(participantSlot("user-42"));
    for (const seed of ["a", "b", "김현민", 0, 11, 12, -5]) {
      const slot = participantSlot(seed);
      expect(slot).toBeGreaterThanOrEqual(1);
      expect(slot).toBeLessThanOrEqual(12);
    }
    expect(participantSlot(0)).toBe(1);
    expect(participantSlot(12)).toBe(1);
  });
});
