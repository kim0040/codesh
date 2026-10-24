import { isThemeId, type ThemeId } from "@codesh/highlight";
import { useSyncExternalStore } from "react";

/** Editor preferences, kept on this device (localStorage) and applied live. */

export const KEYMAPS = ["default", "vim", "emacs", "sublime"] as const;
export type Keymap = (typeof KEYMAPS)[number];

export interface EditorPrefs {
  /** `auto` follows the app theme: Slate in dark, Paper in light. */
  editorTheme: ThemeId | "auto";
  fontSize: number;
  tabSize: number;
  indentWithTabs: boolean;
  wrap: boolean;
  lineNumbers: boolean;
  keymap: Keymap;
  /** The cursor glides as you type (none under `prefers-reduced-motion`). */
  smoothTyping: boolean;
  /** Show invites as system notifications while the tab is in the background. */
  notifications: boolean;
  /** Keep an offline copy of each share in this browser (IndexedDB). */
  offlineCopy: boolean;
}

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 28;
export const TAB_SIZES = [2, 3, 4, 8] as const;

export const DEFAULT_PREFS: EditorPrefs = {
  editorTheme: "auto",
  fontSize: 14,
  tabSize: 2,
  indentWithTabs: false,
  wrap: true,
  lineNumbers: true,
  keymap: "default",
  smoothTyping: true,
  notifications: false,
  offlineCopy: true,
};

const STORAGE_KEY = "codesh.prefs";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Accepts anything that was stored and returns a complete, valid preference object. */
export function sanitizePrefs(input: unknown): EditorPrefs {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  const num = (key: string, fallback: number, min: number, max: number) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? clamp(raw[key] as number, min, max)
      : fallback;
  const bool = (key: string, fallback: boolean) =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : fallback;
  const theme = raw.editorTheme;
  const keymap = raw.keymap;
  return {
    editorTheme: isThemeId(theme) ? theme : "auto",
    fontSize: num("fontSize", d.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX),
    tabSize: num("tabSize", d.tabSize, 1, 8),
    indentWithTabs: bool("indentWithTabs", d.indentWithTabs),
    wrap: bool("wrap", d.wrap),
    lineNumbers: bool("lineNumbers", d.lineNumbers),
    keymap: KEYMAPS.find((k) => k === keymap) ?? d.keymap,
    smoothTyping: bool("smoothTyping", d.smoothTyping),
    notifications: bool("notifications", d.notifications),
    offlineCopy: bool("offlineCopy", d.offlineCopy),
  };
}

function load(): EditorPrefs {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return sanitizePrefs(text ? JSON.parse(text) : {});
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: EditorPrefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): EditorPrefs {
  current ??= load();
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

export function setPrefs(patch: Partial<EditorPrefs>): void {
  current = sanitizePrefs({ ...getPrefs(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Blocked storage: the change still applies until the tab closes.
  }
  emit();
}

export function resetPrefs(): void {
  setPrefs({ ...DEFAULT_PREFS });
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      current = load();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePrefs(): EditorPrefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, () => DEFAULT_PREFS);
}
