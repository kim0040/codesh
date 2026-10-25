/** The visitor's OS family, for key labels and the few styles that differ by platform. */

export type Platform = "mac" | "windows" | "other";

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string };
}

export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  // `platform` first: browsers and test runners that fake an OS set it, and it is never empty.
  // iPadOS reports "MacIntel" (and ⌘ is what its hardware keyboard has), so it lands here too.
  const name = `${nav?.platform ?? ""} ${nav?.userAgentData?.platform ?? ""}`;
  if (/Mac|iPhone|iPad|iPod/i.test(name)) return "mac";
  if (/Win/i.test(name)) return "windows";
  return "other";
}

/**
 * True on iPhone, iPad and iPadOS in any browser: all of them are WebKit and zoom into a focused
 * control whose text is under 16 px. The same check runs inline in index.html before the app loads.
 */
export function isIos(nav: NavigatorLike | undefined): boolean {
  if (!nav) return false;
  const platform = `${nav.platform ?? ""} ${nav.userAgentData?.platform ?? ""}`;
  return (
    /iPhone|iPad|iPod/i.test(platform) ||
    (/MacIntel/i.test(platform) && (nav.maxTouchPoints ?? 0) > 1)
  );
}

export const PLATFORM: Platform = detectPlatform(
  typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike),
);

export interface KeyLabels {
  /** ⌘ on a Mac, Ctrl elsewhere: the key shortcuts are built on. */
  mod: string;
  /** The Control key itself: ⌃ on a Mac (a different key from ⌘), Ctrl elsewhere. */
  ctrl: string;
  alt: string;
  shift: string;
}

export function keyLabelsFor(platform: Platform): KeyLabels {
  return platform === "mac"
    ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
}

/** Modifier names for shortcut hints: ⌃ ⌥ ⇧ ⌘ on Apple devices, Ctrl Alt Shift elsewhere. */
export const KEYS: KeyLabels = keyLabelsFor(PLATFORM);

/**
 * Ctrl+Alt is how Windows reports AltGr, which types characters on many keyboard layouts
 * (AltGr+C is "ć" on a Polish one). App shortcuts built on Ctrl+Alt must let those through.
 */
export function isAltGraph(event: Pick<KeyboardEvent, "getModifierState">): boolean {
  return event.getModifierState?.("AltGraph") ?? false;
}
