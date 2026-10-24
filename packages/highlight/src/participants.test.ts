import { describe, expect, it } from "vitest";
import { contrastRatio, deltaE } from "./color.js";
import { PARTICIPANT_COLORS, participantColor } from "./participants.js";
import { EDITOR_THEMES } from "./themes.js";

/** Surfaces of the UI tokens (`packages/ui` tokens.css) a cursor, avatar or chip can sit on. */
const UI_SURFACES = ["#0a0c13", "#12131c", "#191b25", "#f2f4fa", "#fcfcff", "#ffffff"];
const EDITOR_BACKGROUNDS = EDITOR_THEMES.map((theme) => theme.background);

describe("participant palette", () => {
  it("has the 12 agreed colours in order", () => {
    expect(PARTICIPANT_COLORS.map((c) => c.hex)).toEqual([
      "#c24558",
      "#118d52",
      "#9b56b8",
      "#8c8308",
      "#2e6fcd",
      "#d26124",
      "#098b86",
      "#b74a8e",
      "#5f8807",
      "#6b5fc9",
      "#af7810",
      "#077aa1",
    ]);
  });

  it("draws cursor bars at 3:1 or more on every editor background and UI surface", () => {
    for (const { hex } of PARTICIPANT_COLORS) {
      for (const surface of [...EDITOR_BACKGROUNDS, ...UI_SURFACES]) {
        expect(contrastRatio(hex, surface), `${hex} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps the chip label at 4.5:1 or more on the chip colour", () => {
    for (const { hex, label } of PARTICIPANT_COLORS) {
      expect(contrastRatio(label, hex), `${label} on ${hex}`).toBeGreaterThanOrEqual(4.5);
      const other = label === "#ffffff" ? "#0a0c10" : "#ffffff";
      expect(contrastRatio(label, hex)).toBeGreaterThanOrEqual(contrastRatio(other, hex));
    }
  });

  it("keeps participants distinguishable from each other", () => {
    for (let i = 0; i < PARTICIPANT_COLORS.length; i++) {
      for (let j = i + 1; j < PARTICIPANT_COLORS.length; j++) {
        const a = PARTICIPANT_COLORS[i]?.hex ?? "";
        const b = PARTICIPANT_COLORS[j]?.hex ?? "";
        expect(deltaE(a, b), `${a}~${b}`).toBeGreaterThanOrEqual(0.06);
      }
    }
  });

  it("keeps participants apart from the syntax colours of every theme", () => {
    for (const theme of EDITOR_THEMES) {
      for (const [name, colour] of Object.entries({
        foreground: theme.foreground,
        ...theme.tokens,
      })) {
        for (const { hex } of PARTICIPANT_COLORS) {
          expect(
            deltaE(colour, hex),
            `${theme.id}.${name} ${colour}~${hex}`,
          ).toBeGreaterThanOrEqual(0.045);
        }
      }
    }
  });

  it("hands out stable colours", () => {
    expect(participantColor("user-1")).toBe(participantColor("user-1"));
    expect(participantColor(0)).toBe(PARTICIPANT_COLORS[0]);
    expect(participantColor(13)).toBe(PARTICIPANT_COLORS[1]);
    expect(participantColor(-1)).toBe(PARTICIPANT_COLORS[11]);
    const used = new Set(Array.from({ length: 200 }, (_, i) => participantColor(`u${i}`).hex));
    expect(used.size).toBe(12);
  });
});
