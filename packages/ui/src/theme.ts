/** Theme preference: follow the OS, or force dark/light. Applied as `data-theme` on <html>. */
export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "gachipad.theme";

export function getStoredTheme(): ThemePreference {
  try {
    // legacy codesh name (1.0.x); remove in 2.0
    const value = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("codesh.theme");
    return value === "dark" || value === "light" ? value : "system";
  } catch {
    return "system";
  }
}

/** Sets (or clears, for `system`) the override and remembers it when storage is available. */
export function setTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
) {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  try {
    // legacy codesh name (1.0.x); remove in 2.0
    if (localStorage.getItem("gachipad.legacy-storage") === "1" && preference !== "system") {
      localStorage.setItem("codesh.theme", preference);
    } else localStorage.removeItem("codesh.theme");
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Private mode or blocked storage: the theme still applies for this page view.
  }
}

/** What the page currently renders, after resolving `system` against the OS setting. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Call before first paint (inline in index.html or at the top of main.tsx) to avoid a theme flash. */
export function applyStoredTheme() {
  setTheme(getStoredTheme());
}
