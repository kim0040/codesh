/*
 * App theme preference, stored under the same key and applied the same way as @codesh/ui's
 * theme.ts. Kept here so the intro route does not load the UI component barrel for three buttons.
 */
export type ThemePreference = "system" | "dark" | "light";

const STORAGE_KEY = "codesh.theme";

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : "system";
  } catch {
    return "system";
  }
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
