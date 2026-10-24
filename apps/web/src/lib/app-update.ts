import { registerSW } from "virtual:pwa-register";
import { useSyncExternalStore } from "react";
import { flushPendingSessions } from "./collab/session";

/**
 * Picking up a new build after the server was updated. The service worker no longer swaps itself
 * in silently: a new build waits, and the prompt offers a reload that only ever happens on a click,
 * so a live editing session is never cut off. The server's `/api/version` is compared with this
 * build's version on start, when the tab becomes visible, every half hour and after every collab
 * reconnect (a server restart), which also covers a changed collab protocol.
 */

/** The root package.json version, set by vite.config.ts. */
export const BUILD_VERSION: string = import.meta.env.VITE_APP_VERSION || "0.0.0";

export interface AppUpdateState {
  /** A newer build is waiting, or the server runs another version than this tab. */
  available: boolean;
  serverVersion: string | null;
}

const PERIOD_MS = 30 * 60_000;
const MIN_GAP_MS = 60_000;

let state: AppUpdateState = { available: false, serverVersion: null };
let dismissedFor: string | null = null;
const listeners = new Set<() => void>();
let updateServiceWorker: ((reload?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | undefined;
let lastCheck = 0;
let started = false;
let reloadApproved = false;

function publish(next: AppUpdateState) {
  state = next;
  for (const listener of listeners) listener();
}

const key = () => state.serverVersion ?? "build";

function markAvailable(serverVersion: string | null) {
  publish({ available: true, serverVersion: serverVersion ?? state.serverVersion });
}

/** Registers the service worker in prompt mode and starts the version checks. Call once. */
export function startAppUpdates(): void {
  if (started) return;
  started = true;
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh: () => markAvailable(null),
      // Workbox broadcasts controlling to every tab. Approval belongs to this JS context only.
      onNeedReload: () => {
        if (reloadApproved) void reloadWhenSynced();
      },
      onRegisteredSW: (_url, value) => {
        registration = value;
      },
    });
  }
  void checkServerVersion(0);
  window.setInterval(() => void checkServerVersion(), PERIOD_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkServerVersion();
  });
}

/** Asks the server for its version unless that happened within `minGapMs`. Never throws. */
export async function checkServerVersion(minGapMs = MIN_GAP_MS): Promise<void> {
  if (Date.now() - lastCheck < minGapMs) return;
  lastCheck = Date.now();
  try {
    const response = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return;
    const { version } = (await response.json()) as { version?: unknown };
    if (typeof version !== "string" || !version || version === BUILD_VERSION) return;
    // Lets the service worker fetch the new build now, so the reload gets it.
    void registration?.update().catch(() => undefined);
    markAvailable(version);
  } catch {
    // Offline or the server is restarting: the next trigger asks again.
  }
}

/** Collab connected again: the server may have restarted with another version. */
export function onCollabConnected(): void {
  void checkServerVersion(5000);
}

async function reloadWhenSynced(): Promise<boolean> {
  if (!(await flushPendingSessions())) {
    reloadApproved = false;
    return false;
  }
  // No await between the last pending check and reload: typing cannot slip into that gap.
  window.location.reload();
  return true;
}

/** Reloads only this tab after its user agrees and all its document edits are acknowledged. */
export async function applyAppUpdate(): Promise<boolean> {
  if (registration && updateServiceWorker) {
    await registration.update().catch(() => undefined);
    if (!(await flushPendingSessions())) return false;
    reloadApproved = true;
    if (registration.waiting) {
      try {
        await updateServiceWorker();
        return true;
      } catch {
        reloadApproved = false;
        return false;
      }
    }
  }
  return reloadWhenSynced();
}

/** "Later": hidden until another version shows up. */
export function dismissAppUpdate(): void {
  dismissedFor = key();
  publish({ ...state });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The current state outside React (tests). */
export function appUpdateState(): AppUpdateState & { dismissed: boolean } {
  return { ...state, dismissed: dismissedFor === key() };
}

export function useAppUpdate(): AppUpdateState & { dismissed: boolean } {
  const current = useSyncExternalStore(subscribe, () => state);
  return { ...current, dismissed: dismissedFor === key() };
}
