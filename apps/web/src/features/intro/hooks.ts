import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMedia(query: string, callback: () => void): () => void {
  const list = window.matchMedia(query);
  list.addEventListener("change", callback);
  return () => list.removeEventListener("change", callback);
}

/** True when the visitor asked the system for less motion. Server-safe: false until mounted. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => subscribeMedia(REDUCED_QUERY, callback),
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

export type Appearance = "dark" | "light";

function readAppearance(): Appearance {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function subscribeAppearance(callback: () => void): () => void {
  const list = window.matchMedia("(prefers-color-scheme: light)");
  list.addEventListener("change", callback);
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    list.removeEventListener("change", callback);
    observer.disconnect();
  };
}

/** The theme the page currently renders: `data-theme` on <html> wins, else the OS setting. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, readAppearance, () => "dark");
}

/** True while the element is on screen (with a margin), so loops can stop when nobody sees them. */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  rootMargin = "0px",
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/** True while the tab is visible. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Scroll reveal: every `[data-reveal]` inside `root` gets `data-in` the first time it nears the
 * viewport. CSS animates opacity and transform only, and shows everything at once when motion is
 * reduced or IntersectionObserver is missing.
 */
export function useScrollReveal(root: RefObject<HTMLElement | null>, reduced: boolean) {
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const targets = Array.from(container.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (reduced || typeof IntersectionObserver === "undefined") {
      for (const node of targets) node.dataset.in = "";
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.in = "";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const node of targets) {
      if (!("in" in node.dataset)) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [root, reduced]);
}
