/*
 * App theme preference, stored under the same key and applied the same way as @codesh/ui's
 * theme.ts. Kept here so the intro route does not load the UI component barrel for a few buttons.
 * `data-theme` on <html> is the source of truth, so every control on the page reads and follows it.
 */
import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "dark" | "light";

const STORAGE_KEY = "codesh.theme";

function readThemePreference(): ThemePreference {
  const forced = document.documentElement.getAttribute("data-theme");
  return forced === "dark" || forced === "light" ? forced : "system";
}

function subscribeThemePreference(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The current preference; re-renders whenever any control (or anything else) changes it. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeThemePreference, readThemePreference, () => "system");
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The theme still applies for this page view.
  }
}
