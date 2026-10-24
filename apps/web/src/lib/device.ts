import type { SessionResponse } from "@codesh/shared";
import { api } from "./api";
import { dropAllKeys, dropKey } from "./credentials";
import { queryClient } from "./query";

/**
 * What this browser keeps of a share, and how it is forgotten (docs/ARCHITECTURE.md §14).
 * The offline copy is one IndexedDB database per share; forgetting closes the open connections of
 * every tab first (a database with an open connection is not deleted), then deletes it.
 */

export const IDB_PREFIX = "codesh:doc:";
export const idbName = (shareId: string) => `${IDB_PREFIX}${shareId}`;

const CHANNEL = "codesh:device";
const STORAGE_EVENT_KEY = "codesh.forget";
const SUBJECT_KEY = "codesh.device.subject";
const DELETE_TIMEOUT_MS = 4000;

/** An open document that holds a local copy and can let go of it. */
export interface LocalHolder {
  shareId: string;
  /** Close the IndexedDB connection and stop writing a copy until the user allows it again. */
  releaseLocal(): Promise<void>;
}

const holders = new Set<LocalHolder>();

export function registerHolder(holder: LocalHolder): () => void {
  holders.add(holder);
  return () => holders.delete(holder);
}

type Message = { type: "share"; shareId: string } | { type: "all" };

const tabId = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    channel?.addEventListener("message", (event: MessageEvent<Message>) => receive(event.data));
  } catch {
    channel = null;
  }
  return channel;
}

function broadcast(message: Message): void {
  const bus = getChannel();
  if (bus) {
    bus.postMessage(message);
    return;
  }
  // No BroadcastChannel: a storage event reaches the other tabs of this origin.
  try {
    localStorage.setItem(
      STORAGE_EVENT_KEY,
      JSON.stringify({ tab: tabId, at: Date.now(), message }),
    );
  } catch {
    // Blocked storage: there is no copy to forget in other tabs either.
  }
}

function receive(message: Message | undefined): void {
  if (message?.type === "share") void forgetShare(message.shareId, { broadcast: false });
  else if (message?.type === "all") {
    void forgetAll({ broadcast: false }).then(() => window.location.replace("/"));
  }
}

/** Starts listening for "forget" from other tabs. Called once at start. */
export function listenForForgetting(): void {
  getChannel();
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_EVENT_KEY || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as { tab?: string; message?: Message };
      if (parsed.tab !== tabId) receive(parsed.message);
    } catch {
      // Not ours.
    }
  });
}

/** Deletes one IndexedDB database. False when it stayed (blocked, denied, no IndexedDB). */
export function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(false);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // A blocked delete completes once the other connections close; do not wait forever.
    const timer = setTimeout(() => finish(false), DELETE_TIMEOUT_MS);
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

async function deleteWithRetry(name: string): Promise<boolean> {
  return (await deleteDatabase(name)) || (await deleteDatabase(name));
}

/**
 * Forgets one share on this device: closes its connections in every tab, deletes the offline copy
 * and drops the remembered edit key. Returns false when the copy could not be deleted.
 */
export async function forgetShare(
  shareId: string,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  if (options.broadcast !== false) broadcast({ type: "share", shareId });
  await Promise.all([...holders].filter((h) => h.shareId === shareId).map((h) => h.releaseLocal()));
  dropKey(shareId);
  return deleteWithRetry(idbName(shareId));
}

async function copyNames(): Promise<string[]> {
  const names = new Set([...holders].map((holder) => idbName(holder.shareId)));
  try {
    for (const info of (await indexedDB.databases?.()) ?? []) {
      if (info.name?.startsWith(IDB_PREFIX)) names.add(info.name);
    }
  } catch {
    // `databases()` is missing or refused: only the open documents are known.
  }
  return [...names];
}

/** Forgets every share of this browser: all offline copies and all remembered edit keys. */
export async function forgetAll(options: { broadcast?: boolean } = {}): Promise<boolean> {
  if (options.broadcast !== false) broadcast({ type: "all" });
  const names = await copyNames();
  await Promise.all([...holders].map((holder) => holder.releaseLocal()));
  dropAllKeys();
  const results = await Promise.all(names.map(deleteWithRetry));
  return results.every(Boolean);
}

/** Logout: the server forgets the identity and issues a new session, this browser forgets the rest. */
export async function signOut(): Promise<boolean> {
  let loggedOut = true;
  try {
    await api.logout();
  } catch {
    loggedOut = false;
  }
  const forgotten = await forgetAll();
  try {
    localStorage.removeItem(SUBJECT_KEY);
  } catch {
    // Nothing stored.
  }
  queryClient.clear();
  return loggedOut && forgotten;
}

/** This browser has seen a session before, so a changed identity can still be noticed. */
export function hasSeenSession(): boolean {
  try {
    return localStorage.getItem(SUBJECT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Account switching: when the verified identity of the session differs from the one this device
 * last saw, the previous account's copies must not be reachable by the next one.
 */
export function noteSessionIdentity(session: SessionResponse): void {
  const identity = session.identity;
  const subject = identity ? `${identity.provider}:${identity.email ?? identity.name ?? ""}` : "";
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(SUBJECT_KEY);
    localStorage.setItem(SUBJECT_KEY, subject);
  } catch {
    return;
  }
  if (previous !== null && previous !== subject) void forgetAll();
}
