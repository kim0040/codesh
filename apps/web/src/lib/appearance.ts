import { useSyncExternalStore } from "react";

export type Appearance = "dark" | "light";

function read(): Appearance {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function subscribe(callback: () => void): () => void {
  const list = window.matchMedia("(prefers-color-scheme: light)");
  list.addEventListener("change", callback);
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    list.removeEventListener("change", callback);
    observer.disconnect();
  };
}

/** The app theme the page renders right now (`data-theme` on <html>, else the OS setting). */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

const REDUCED = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED).matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const list = window.matchMedia(REDUCED);
      list.addEventListener("change", callback);
      return () => list.removeEventListener("change", callback);
    },
    prefersReducedMotion,
    () => false,
  );
}

const NARROW = "(max-width: 47.99rem)";

/** True below the `md` breakpoint (48rem). */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const list = window.matchMedia(NARROW);
      list.addEventListener("change", callback);
      return () => list.removeEventListener("change", callback);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}
