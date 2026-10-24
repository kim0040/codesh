import type { SessionResponse } from "@codesh/shared";
import { api, isApiError } from "./api";
import { dropAllKeys, dropKey } from "./credentials";
import { getPrefs, setPrefs } from "./prefs";
import { queryClient } from "./query";

/**
 * What this browser keeps of a share, and how it is forgotten (docs/ARCHITECTURE.md §14).
 * The offline copy is one IndexedDB database per share, written only after the device choice
 * "keep offline copies on this device" was answered yes. Every database is listed in a registry
 * before it is created, so it can be deleted even where `indexedDB.databases()` is missing.
 * Leaving a share (forget, denial, logout, another account) tears its open documents down in
 * every tab first (a database with an open connection is not deleted), then deletes the copy.
 */

export const IDB_PREFIX = "codesh:doc:";
export const idbName = (shareId: string) => `${IDB_PREFIX}${shareId}`;

const CHANNEL = "codesh:device";
const STORAGE_EVENT_KEY = "codesh.forget";
/** The clientId of the session this device saw last; login and logout rotate it. */
const SUBJECT_KEY = "codesh.device.subject";
/** `{ complete, ids }`: shares whose database may exist. Not complete: copies from before it. */
const REGISTRY_KEY = "codesh.device.copies";
/** Share ids "Forget on this device" was used on: no copy until the user turns copies on again. */
const FORGOTTEN_KEY = "codesh.device.forgotten";
/** `{ all, ids }`: deletions that are not confirmed yet. No copy is written meanwhile. */
const ERASE_KEY = "codesh.device.erase";
const DELETE_TIMEOUT_MS = 4000;

/** An open document that holds a local copy and can let go of it. */
export interface LocalHolder {
  shareId: string;
  /** Close the IndexedDB connection and stop writing a copy; the document stays open. */
  releaseLocal(): Promise<void>;
  /** Leave the share: provider, document, credentials and the copy's connection all go. */
  leave(): Promise<void>;
}

const holders = new Set<LocalHolder>();

export function registerHolder(holder: LocalHolder): () => void {
  holders.add(holder);
  return () => holders.delete(holder);
}

// stored lists

interface Registry {
  complete: boolean;
  ids: string[];
}

interface Erase {
  all: boolean;
  ids: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Reads a JSON value; throws when storage is blocked, so callers can fail closed. */
function read(key: string): Record<string, unknown> | unknown[] | null {
  const text = localStorage.getItem(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function readRegistry(): Registry | null {
  try {
    const stored = read(REGISTRY_KEY) as Partial<Registry> | null;
    if (stored === null) {
      // No registry yet: an install from before it may hold copies nobody listed.
      const legacy =
        localStorage.getItem("codesh.prefs") !== null || localStorage.getItem(SUBJECT_KEY) !== null;
      return { complete: !legacy, ids: [] };
    }
    return { complete: stored.complete === true, ids: strings(stored.ids) };
  } catch {
    return null;
  }
}

function readErase(): Erase | null {
  try {
    const stored = read(ERASE_KEY) as Partial<Erase> | null;
    return { all: stored?.all === true, ids: strings(stored?.ids) };
  } catch {
    return null;
  }
}

function updateErase(change: (erase: Erase) => Erase): void {
  const erase = readErase();
  if (erase) write(ERASE_KEY, change(erase));
}

function forgottenIds(): string[] | null {
  try {
    return strings(read(FORGOTTEN_KEY));
  } catch {
    return null;
  }
}

function setForgotten(shareId: string, forgotten: boolean): void {
  const ids = (forgottenIds() ?? []).filter((id) => id !== shareId);
  write(FORGOTTEN_KEY, forgotten ? [...ids, shareId] : ids);
}

export function isForgotten(shareId: string): boolean {
  return forgottenIds()?.includes(shareId) ?? true;
}

/**
 * A copy of this share may be written: the device choice is yes, the share was not forgotten, no
 * deletion is pending and the registry can list it. Anything unreadable counts as no.
 */
export function mayKeepCopy(shareId: string): boolean {
  if (getPrefs().offlineCopy !== "yes") return false;
  const erase = readErase();
  if (!erase || erase.all || erase.ids.includes(shareId)) return false;
  return !isForgotten(shareId);
}

/** Lists the share's database before it is created. False when it may not be created. */
export function noteCopy(shareId: string): boolean {
  if (!mayKeepCopy(shareId)) return false;
  const registry = readRegistry();
  if (!registry) return false;
  if (registry.ids.includes(shareId)) return true;
  return write(REGISTRY_KEY, { ...registry, ids: [...registry.ids, shareId] });
}

function unlist(shareIds: string[]): void {
  if (shareIds.length === 0) return;
  const registry = readRegistry();
  if (registry) {
    write(REGISTRY_KEY, { ...registry, ids: registry.ids.filter((id) => !shareIds.includes(id)) });
  }
  updateErase((erase) => ({ ...erase, ids: erase.ids.filter((id) => !shareIds.includes(id)) }));
}

// tabs

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
  write(STORAGE_EVENT_KEY, { tab: tabId, at: Date.now(), message });
}

function receive(message: Message | undefined): void {
  if (message?.type === "share") void leaveShare(message.shareId, { broadcast: false });
  else if (message?.type === "all") {
    void forgetAll({ broadcast: false }).then(() => window.location.replace("/"));
  }
}

/**
 * Called once at start: listens for "forget" from other tabs and finishes deletions that are
 * still due (the device choice is not yes, a forgotten share, an unconfirmed earlier deletion).
 */
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
  const registry = readRegistry();
  if (registry) write(REGISTRY_KEY, registry);
  void sweep();
}

// deleting

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

/** Deletes these databases and unlists the ones that went. True when all of them went. */
async function deleteCopies(names: string[]): Promise<boolean> {
  const results = await Promise.all(names.map(deleteWithRetry));
  unlist(names.filter((_, i) => results[i]).map((name) => name.slice(IDB_PREFIX.length)));
  return results.every(Boolean);
}

/**
 * Every database name this browser may hold: the registry, open documents and, where it works,
 * `indexedDB.databases()`. `complete` is false when a copy could be missing from the list.
 */
async function knownCopies(): Promise<{ names: string[]; complete: boolean }> {
  const registry = readRegistry();
  const ids = new Set([...(registry?.ids ?? []), ...[...holders].map((holder) => holder.shareId)]);
  let listed = false;
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      for (const info of await indexedDB.databases()) {
        if (info.name?.startsWith(IDB_PREFIX)) ids.add(info.name.slice(IDB_PREFIX.length));
      }
      listed = true;
    }
  } catch {
    // `databases()` refused: only the registry is known.
  }
  if (listed && registry && !registry.complete) {
    write(REGISTRY_KEY, { complete: true, ids: [...ids] });
  }
  return { names: [...ids].map(idbName), complete: listed || registry?.complete === true };
}

/**
 * Deletes every copy. The erase marker stays while a deletion failed, so the next start retries.
 * An incomplete list is reported as a failure once; nothing more can be found later either, and
 * every copy created from now on is listed.
 */
async function eraseAll(): Promise<boolean> {
  const { names, complete } = await knownCopies();
  const deleted = await deleteCopies(names);
  if (deleted) {
    updateErase(() => ({ all: false, ids: [] }));
    if (!complete) write(REGISTRY_KEY, { complete: true, ids: [] });
  }
  return deleted && complete;
}

/** Deletes every copy that may not be kept (any, while the device choice is not yes). */
export async function sweep(): Promise<boolean> {
  if (readErase()?.all) return eraseAll();
  const { names, complete } = await knownCopies();
  const doomed = names.filter((name) => !mayKeepCopy(name.slice(IDB_PREFIX.length)));
  const deleted = await deleteCopies(doomed);
  // A copy missing from an incomplete list only matters when copies are not wanted at all; it is
  // reported once, as in eraseAll.
  if (complete || getPrefs().offlineCopy === "yes") return deleted;
  if (deleted) write(REGISTRY_KEY, { complete: true, ids: [] });
  return false;
}

// leaving

/** The API refused this client for good: the share is gone, expired, or it is not let in. */
export function isDenial(error: unknown): boolean {
  return (["banned", "not_found", "expired", "forbidden"] as const).some((code) =>
    isApiError(error, code),
  );
}

/**
 * Leaves one share on this device: its open documents in every tab are torn down, then the offline
 * copy and the remembered edit key are deleted. False when the copy could not be deleted (it is
 * retried at the next start).
 */
export async function leaveShare(
  shareId: string,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  updateErase((erase) => ({
    ...erase,
    ids: erase.ids.includes(shareId) ? erase.ids : [...erase.ids, shareId],
  }));
  if (options.broadcast !== false) broadcast({ type: "share", shareId });
  await Promise.all([...holders].filter((h) => h.shareId === shareId).map((h) => h.leave()));
  dropKey(shareId);
  return deleteCopies([idbName(shareId)]);
}

/** "Forget on this device": leave the share, and keep no copy of it until the user asks again. */
export async function forgetShare(shareId: string): Promise<boolean> {
  setForgotten(shareId, true);
  return leaveShare(shareId);
}

/**
 * The device choice. Yes also takes back "Forget" for the share in view; no deletes every copy,
 * including those of shares no tab has open.
 */
export async function chooseOfflineCopy(choice: "yes" | "no", shareId?: string): Promise<boolean> {
  if (choice === "yes") {
    if (shareId) setForgotten(shareId, false);
    setPrefs({ offlineCopy: "yes" });
    return true;
  }
  // Open documents close their copies on the change (here and, by the storage event, elsewhere).
  setPrefs({ offlineCopy: "no" });
  await Promise.all([...holders].map((holder) => holder.releaseLocal()));
  return sweep();
}

/** Forgets every share of this browser: open documents, offline copies and remembered keys. */
export async function forgetAll(options: { broadcast?: boolean } = {}): Promise<boolean> {
  updateErase((erase) => ({ ...erase, all: true }));
  if (options.broadcast !== false) broadcast({ type: "all" });
  await Promise.all([...holders].map((holder) => holder.leave()));
  dropAllKeys();
  return eraseAll();
}

/**
 * Logout: every open document is torn down first, then the server forgets the identity and issues
 * a new session, then this browser deletes the rest.
 */
export async function signOut(): Promise<boolean> {
  updateErase((erase) => ({ ...erase, all: true }));
  broadcast({ type: "all" });
  await Promise.all([...holders].map((holder) => holder.leave()));
  dropAllKeys();
  let loggedOut = true;
  try {
    await api.logout();
  } catch {
    loggedOut = false;
  }
  const forgotten = await eraseAll();
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
 * Account switching: login and logout rotate the session's clientId, and an anonymous session
 * that was replaced has a new one too. When it differs from the one this device saw last, every
 * tab leaves its documents and all copies are deleted before the session is handed out, so no
 * join of the new session starts before that. Not finished: the erase marker blocks every copy
 * until a later start completes it.
 */
export async function noteSessionIdentity(session: SessionResponse): Promise<void> {
  let previous: string | null;
  try {
    previous = localStorage.getItem(SUBJECT_KEY);
  } catch {
    // Blocked storage: no copy is ever written (noteCopy), so there is nothing to protect.
    return;
  }
  if (previous !== null && previous !== session.clientId) await forgetAll();
  else if (readErase()?.all) await eraseAll();
  try {
    localStorage.setItem(SUBJECT_KEY, session.clientId);
  } catch {
    // As above.
  }
}
