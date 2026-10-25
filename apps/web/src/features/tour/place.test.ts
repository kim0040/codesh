import { describe, expect, it } from "vitest";
import { DOCK_BELOW, MARGIN, placePopover, popoverWidth, type Viewport } from "./place";
import type { Box } from "./steps";

const intersects = (a: Box, b: Box) =>
  Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left) &&
  Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top);

const desktop = { width: 1280, height: 800 };
const phone = { width: 320, height: 568 };
const size = (viewport: Viewport, height = 180) => ({
  width: popoverWidth(viewport),
  height,
});

describe("popoverWidth", () => {
  it("is a card on wide screens and fills a 320px screen minus its margins", () => {
    expect(popoverWidth(desktop)).toBe(352);
    expect(popoverWidth(phone)).toBe(320 - MARGIN * 2);
  });
});

describe("placePopover", () => {
  it("goes below an element in the top bar", () => {
    const share: Box = { left: 1100, top: 8, width: 80, height: 28 };
    const place = placePopover(share, size(desktop), desktop);
    expect(place.side).toBe("below");
    expect(place.top).toBeGreaterThan(share.top + share.height);
  });

  it("goes above an element in the status bar", () => {
    const language: Box = { left: 1180, top: 772, width: 80, height: 24 };
    const place = placePopover(language, size(desktop), desktop);
    expect(place.side).toBe("above");
    expect(place.top + 180).toBeLessThan(language.top);
  });

  it("stays inside the screen horizontally", () => {
    const edge: Box = { left: 1250, top: 8, width: 24, height: 24 };
    const place = placePopover(edge, size(desktop), desktop);
    expect(place.left + 352).toBeLessThanOrEqual(desktop.width - MARGIN);
    const start: Box = { left: 0, top: 8, width: 24, height: 24 };
    expect(placePopover(start, size(desktop), desktop).left).toBe(MARGIN);
  });

  it("docks to the screen edge on a narrow screen, away from the element", () => {
    expect(phone.width).toBeLessThan(DOCK_BELOW);
    const share: Box = { left: 230, top: 8, width: 32, height: 32 };
    const high = placePopover(share, size(phone), phone);
    expect(high).toMatchObject({ side: "bottom", left: MARGIN });
    expect(high.top + 180).toBe(phone.height - MARGIN);
    const language: Box = { left: 240, top: 540, width: 64, height: 24 };
    expect(placePopover(language, size(phone), phone)).toMatchObject({ side: "top", top: MARGIN });
  });

  it("never covers the element, on any screen", () => {
    const targets: Box[] = [
      { left: 8, top: 8, width: 32, height: 32 },
      { left: 230, top: 8, width: 32, height: 32 },
      { left: 120, top: 60, width: 150, height: 36 },
      { left: 240, top: 540, width: 64, height: 24 },
    ];
    for (const viewport of [phone, { width: 480, height: 640 }, { width: 800, height: 420 }]) {
      for (const target of targets) {
        const place = placePopover(target, size(viewport, 200), viewport);
        const popover: Box = { left: place.left, top: place.top, ...size(viewport, 200) };
        expect(intersects(popover, target), JSON.stringify({ viewport, target, place })).toBe(
          false,
        );
      }
    }
  });

  it("docks on a wide but short screen where neither side has room", () => {
    const viewport = { width: 1000, height: 300 };
    const middle: Box = { left: 400, top: 130, width: 100, height: 40 };
    const place = placePopover(middle, size(viewport, 220), viewport);
    expect(["top", "bottom"]).toContain(place.side);
  });
});
