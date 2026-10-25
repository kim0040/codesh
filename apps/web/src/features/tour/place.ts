import type { Box } from "./steps";

export interface Viewport {
  width: number;
  height: number;
}

/** Where the popover sits relative to the highlighted element. */
export type Side = "below" | "above" | "top" | "bottom";

export interface Placement {
  left: number;
  top: number;
  /** `top` and `bottom` dock the popover to a screen edge, away from the element. */
  side: Side;
}

/** Gap to the element, margin to the screen edge, and the width under which the popover docks. */
export const GAP = 12;
export const MARGIN = 8;
export const DOCK_BELOW = 480;
export const POPOVER_WIDTH = 352;

/** Popover width at this screen width: a card on wide screens, edge to edge (minus margins) on 320px. */
export function popoverWidth(viewport: Viewport): number {
  return Math.min(POPOVER_WIDTH, viewport.width - MARGIN * 2);
}

function overlap(a: Box, b: Box): number {
  const x = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

/**
 * Puts the popover next to the element without covering it. A card goes below, else above; when
 * neither fits, or the screen is narrow, it docks to the top or bottom edge on the side the
 * element is not on. Pure so the layout can be tested without a browser.
 */
export function placePopover(
  target: Box,
  size: { width: number; height: number },
  viewport: Viewport,
): Placement {
  const left = Math.min(
    Math.max(target.left + target.width / 2 - size.width / 2, MARGIN),
    Math.max(MARGIN, viewport.width - size.width - MARGIN),
  );
  if (viewport.width >= DOCK_BELOW) {
    const below = target.top + target.height + GAP;
    if (below + size.height <= viewport.height - MARGIN) return { left, top: below, side: "below" };
    const above = target.top - GAP - size.height;
    if (above >= MARGIN) return { left, top: above, side: "above" };
  }
  const bottom = { left, top: viewport.height - MARGIN - size.height, side: "bottom" as const };
  const top = { left, top: MARGIN, side: "top" as const };
  const at = (placement: Placement): Box => ({ ...placement, ...size });
  const covered = (placement: Placement) => overlap(at(placement), target);
  // The element in the lower half keeps the bottom free: dock at the top, and the other way round.
  const preferred = target.top + target.height / 2 > viewport.height / 2 ? top : bottom;
  const other = preferred === top ? bottom : top;
  return covered(preferred) <= covered(other) ? preferred : other;
}
