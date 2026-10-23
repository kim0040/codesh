/*
 * Participant colours for cursors, selections' name chips and avatars.
 *
 * One set of 12 serves both light and dark themes: found by searching OKLCH for hues spread around
 * the wheel, each with ≥3:1 against every editor and UI surface (cursor bars are non-text graphics)
 * and ≥0.06 OKLab distance from each other. A chip carries its name in `label`, white or ink,
 * whichever reads at ≥4.5:1 on that colour. The search keeps these clear of the syntax token colours
 * of every editor theme (≥0.045 OKLab) so a remote cursor is never mistaken for coloured code.
 */

export interface ParticipantColor {
  /** Cursor bar, selection tint base and avatar background. */
  readonly hex: string;
  /** Text colour on a chip filled with `hex`. */
  readonly label: "#ffffff" | "#0a0c10";
}

export const PARTICIPANT_COLORS: readonly ParticipantColor[] = [
  { hex: "#c24558", label: "#ffffff" },
  { hex: "#118d52", label: "#0a0c10" },
  { hex: "#9b56b8", label: "#ffffff" },
  { hex: "#8c8308", label: "#0a0c10" },
  { hex: "#2e6fcd", label: "#ffffff" },
  { hex: "#d26124", label: "#0a0c10" },
  { hex: "#098b86", label: "#0a0c10" },
  { hex: "#b74a8e", label: "#ffffff" },
  { hex: "#5f8807", label: "#0a0c10" },
  { hex: "#6b5fc9", label: "#ffffff" },
  { hex: "#af7810", label: "#0a0c10" },
  { hex: "#077aa1", label: "#ffffff" },
];

/** FNV-1a, so the same user id maps to the same colour on every device. */
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

/** Stable colour for a participant: pass the user id (or a slot number to hand out in order). */
export function participantColor(seed: string | number): ParticipantColor {
  const index =
    typeof seed === "number"
      ? ((Math.trunc(seed) % PARTICIPANT_COLORS.length) + PARTICIPANT_COLORS.length) %
        PARTICIPANT_COLORS.length
      : hashSeed(seed) % PARTICIPANT_COLORS.length;
  return PARTICIPANT_COLORS[index] as ParticipantColor;
}
