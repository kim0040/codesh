import { isShareId } from "@codesh/shared";
import { useSyncExternalStore } from "react";

/**
 * The edit key of a link. It travels in the URL fragment (`/<id>#key=...`), which browsers never
 * send to a server, and is lifted out of the address bar the moment the page starts: it lives in
 * memory, is passed only in the body of the join request and never reaches router state, history
 * entries or logs. Links from before (`?key=...`) are still accepted and scrubbed the same way.
 */

const KEY_PARAM = "key";

const keys = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

/** Removes every `key` entry from a `?...` or `#...` part; other entries stay as they were. */
export function stripKey(part: string): { key: string | null; rest: string } {
  if (part.length <= 1) return { key: null, rest: part };
  const lead = part[0];
  let key: string | null = null;
  const kept: string[] = [];
  for (const entry of part.slice(1).split("&")) {
    const eq = entry.indexOf("=");
    const name = safeDecode(eq === -1 ? entry : entry.slice(0, eq));
    if (name === KEY_PARAM) {
      key ??= safeDecode(eq === -1 ? "" : entry.slice(eq + 1));
    } else kept.push(entry);
  }
  if (key === null) return { key: null, rest: part };
  return { key: key || null, rest: kept.length > 0 ? `${lead}${kept.join("&")}` : "" };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export interface ScrubbedLocation {
  key: string | null;
  /** The address without the key, or null when it had none. */
  url: string | null;
}

/** Finds a key in the fragment (new links) or the query (legacy links) and removes it. */
export function scrubLocation(location: {
  pathname: string;
  search: string;
  hash: string;
}): ScrubbedLocation {
  const fromHash = stripKey(location.hash);
  const fromSearch = stripKey(location.search);
  if (fromHash.rest === location.hash && fromSearch.rest === location.search) {
    return { key: null, url: null };
  }
  return {
    key: fromHash.key ?? fromSearch.key,
    url: `${location.pathname}${fromSearch.rest}${fromHash.rest}`,
  };
}

function shareIdOfPath(pathname: string): string | null {
  const id = pathname.split("/").filter(Boolean)[0];
  return id && isShareId(id) ? id : null;
}

/**
 * Takes the key out of the current address into memory and rewrites the address without it.
 * `replace` defaults to `history.replaceState`, which keeps the history entry's own state.
 */
export function captureKeyFromUrl(
  replace: (url: string) => void = (url) =>
    window.history.replaceState(window.history.state, "", url),
): void {
  const { key, url } = scrubLocation(window.location);
  if (url === null) return;
  replace(url);
  const id = shareIdOfPath(window.location.pathname);
  if (key && id) {
    keys.set(id, key);
    emit();
  }
}

/** A key pasted into the address bar of an open tab changes only the fragment: no reload. */
export function watchKeyInUrl(replace: (url: string) => void): void {
  window.addEventListener("hashchange", () => captureKeyFromUrl(replace));
}

export function getKey(shareId: string): string | undefined {
  return keys.get(shareId);
}

export function dropKey(shareId: string): void {
  if (keys.delete(shareId)) emit();
}

export function dropAllKeys(): void {
  if (keys.size === 0) return;
  keys.clear();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The key that came with this share's link, if any (undefined for a plain link). */
export function useLinkKey(shareId: string): string | undefined {
  useSyncExternalStore(subscribe, () => version);
  return keys.get(shareId);
}
