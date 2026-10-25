import type { SessionResponse } from "@gachipad/shared";
import { api, isApiError } from "./api";
import { dropAllKeys, dropKey } from "./credentials";
import { getPrefs, setPrefs } from "./prefs";
import { queryClient } from "./query";
import {
  isStorageMigrationBlocked,
  LEGACY_IDB_PREFIX,
  LEGACY_STORAGE_PREFIX,
  mirrorLegacy,
  readMigratedKey,
  usesLegacyStorage,
} from "./storage-migration";

/**
 * What this browser keeps of a share, and how it is forgotten (docs/ARCHITECTURE.md §14).
 * The offline copy is one IndexedDB database per share, written only after the device choice
 * "keep offline copies on this device" was answered yes. Every database is listed in a registry
 * before it is created, so it can be deleted even where `indexedDB.databases()` is missing.
 * Leaving a share (forget, denial, logout, another account) tears its open documents down in
 * every tab first (a database with an open connection is not deleted), then deletes the copy.
 */

export const IDB_PREFIX = "gachipad:doc:";
export const idbName = (shareId: string) =>
  `${usesLegacyStorage() ? LEGACY_IDB_PREFIX : IDB_PREFIX}${shareId}`;

const CHANNEL = "gachipad:device";
// legacy codesh name (1.0.x); remove in 2.0
const LEGACY_CHANNEL = "codesh:device";
const STORAGE_EVENT_KEY = "gachipad.forget";
/** The clientId of the session this device saw last; login and logout rotate it. */
const SUBJECT_KEY = "gachipad.device.subject";
/**
 * One localStorage key per share, so tabs that write at the same time never drop each other's
 * entries: its database may exist (listed before it is created), its deletion is not confirmed
 * yet, "Forget on this device" was used on it.
 */
const COPY = "gachipad.device.copy:";
const ERASE = "gachipad.device.erase:";
const FORGOTTEN = "gachipad.device.forgotten:";
/** Every copy has to go (logout, another account); kept until a deletion of all of them worked. */
const ERASE_ALL_KEY = "gachipad.device.erase-all";
/**
 * `indexedDB.databases()` worked once, so every copy since is in the registry. Nothing else sets
 * it: without it a copy from before the registry may be missing from every list.
 */
const COMPLETE_KEY = "gachipad.device.complete";
const DELETE_TIMEOUT_MS = 4000;
/** Closing a document (its IndexedDB connection included) is not waited for longer than this. */
export const CLOSE_TIMEOUT_MS = 4000;
const ASK_TIMEOUT_MS = 300;

/** An open document that holds a local copy and can let go of it. */
export interface LocalHolder {
  shareId: string;
  /** Close the IndexedDB connection and stop writing a copy; the document stays open. */
  releaseLocal(): Promise<void>;
  /** Leave the share: provider, document, credentials and the copy's connection all go. */
  leave(): Promise<void>;
  /** Local edits the server has not confirmed yet. */
  unsent(): number;
}

const holders = new Set<LocalHolder>();

export function registerHolder(holder: LocalHolder): () => void {
  holders.add(holder);
  return () => holders.delete(holder);
}

/** Waits for `promise`, but at most `ms`; whatever it does later is ignored. */
export function within(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

// stored marks

/** This tab's own record of deletions that are due, for when storage refused to keep it. */
const due = { all: false, ids: new Set<string>() };

/** False when the browser refused the write (blocked storage, quota). */
function store(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    mirrorLegacy(key, value);
    return true;
  } catch {
    return false;
  }
}

const mark = (key: string) => store(key, "1");

function unmark(key: string): void {
  try {
    localStorage.removeItem(key);
    mirrorLegacy(key, null);
  } catch {
    // Blocked storage: nothing was stored either.
  }
}

/** Ids stored under a prefix; throws when storage is blocked. */
function storedIds(prefix: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length));
  }
  return ids;
}

function eraseAllDue(): boolean {
  try {
    return due.all || readMigratedKey(ERASE_ALL_KEY) !== null;
  } catch {
    return true;
  }
}

function markEraseAll(): void {
  due.all = true;
  mark(ERASE_ALL_KEY);
}

export function isForgotten(shareId: string): boolean {
  try {
    return readMigratedKey(FORGOTTEN + shareId) !== null;
  } catch {
    return true;
  }
}

/**
 * A copy of this share may be written: the device choice is yes, the share was not forgotten and
 * no deletion is due or still running. Anything unreadable counts as no.
 */
export function mayKeepCopy(shareId: string): boolean {
  if (isStorageMigrationBlocked()) return false;
  if (getPrefs().offlineCopy !== "yes" || due.ids.has(shareId) || eraseAllDue()) return false;
  if (deleting.has(idbName(shareId))) return false;
  try {
    return readMigratedKey(ERASE + shareId) === null && !isForgotten(shareId);
  } catch {
    return false;
  }
}

/** Lists the share's database before it is created. False when it may not be created. */
export function noteCopy(shareId: string): boolean {
  return mayKeepCopy(shareId) && mark(COPY + shareId);
}

/** A copy of this share may be on this device: listed, being deleted, or from before the list. */
function mayHoldCopy(shareId: string): boolean {
  try {
    return (
      readMigratedKey(COPY + shareId) !== null ||
      readMigratedKey(ERASE + shareId) !== null ||
      readMigratedKey(COMPLETE_KEY) === null
    );
  } catch {
    return true;
  }
}

// copies that may remain

let leftovers = false;
let told = false;
const leftoverListeners = new Set<() => void>();

/** A cleanup nobody asked for in this tab (start, another account, a denial) left copies behind. */
function reportLeftovers(): void {
  leftovers = true;
  tell();
}

function tell(): void {
  if (!leftovers || told || leftoverListeners.size === 0) return;
  told = true;
  for (const listener of leftoverListeners) listener();
}

/** Called once per page load when offline copies may have stayed on this device. */
export function onLeftovers(listener: () => void): () => void {
  leftoverListeners.add(listener);
  tell();
  return () => leftoverListeners.delete(listener);
}

// tabs

type Message =
  | { type: "share"; shareId: string }
  | { type: "all" }
  | { type: "identity" }
  | { type: "unsent?"; ask: string; shareId?: string }
  | { type: "unsent"; ask: string };

const tabId = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null | undefined;
const answers = new Map<string, () => void>();
let restarting = false;

/** This tab closed its documents for another account and reloads where it was. */
export function isRestarting(): boolean {
  return restarting;
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(usesLegacyStorage() ? LEGACY_CHANNEL : CHANNEL);
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
    const value = JSON.stringify({ tab: tabId, at: Date.now(), message });
    const key = usesLegacyStorage() ? `${LEGACY_STORAGE_PREFIX}forget` : STORAGE_EVENT_KEY;
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: no copy was written in other tabs either.
  }
}

function receive(message: Message | undefined): void {
  switch (message?.type) {
    case "share":
      void leaveShare(message.shareId, { broadcast: false });
      break;
    case "all":
      void forgetAll({ broadcast: false }).then(() => window.location.replace("/"));
      break;
    case "identity": {
      // Another account in another tab: that tab deletes; this one only lets go and starts over
      // where it was. The editor waits meanwhile instead of going to the start page (isRestarting).
      if (restarting) break;
      restarting = true;
      const here = `${window.location.pathname}${window.location.search}`;
      void closeDocuments().then(() => window.location.replace(here));
      break;
    }
    case "unsent?":
      if (unsentHere(message.shareId) > 0) broadcast({ type: "unsent", ask: message.ask });
      break;
    case "unsent":
      answers.get(message.ask)?.();
      break;
  }
}

/**
 * Called once at start: listens for "forget" from other tabs and finishes deletions that are
 * still due (the device choice is not yes, a forgotten share, an unconfirmed earlier deletion).
 */
export function listenForForgetting(): void {
  getChannel();
  window.addEventListener("storage", (event) => {
    if (
      (event.key !== STORAGE_EVENT_KEY && event.key !== `${LEGACY_STORAGE_PREFIX}forget`) ||
      !event.newValue
    )
      return;
    try {
      const parsed = JSON.parse(event.newValue) as { tab?: string; message?: Message };
      if (parsed.tab !== tabId) receive(parsed.message);
    } catch {
      // Not ours.
    }
  });
  void sweep();
}

/** Leaves the open documents of this tab (of one share, or all of them). */
async function closeDocuments(shareId?: string): Promise<void> {
  const leaving = [...holders].filter((holder) => !shareId || holder.shareId === shareId);
  await Promise.all(leaving.map((holder) => within(holder.leave(), CLOSE_TIMEOUT_MS)));
}

function unsentHere(shareId?: string): number {
  let count = 0;
  for (const holder of holders) {
    if (!shareId || holder.shareId === shareId) count += holder.unsent();
  }
  return count;
}

/**
 * Edits the server has not confirmed yet, in an open document of this share (or of any share)
 * in this tab or another one. Other tabs answer within a moment; a slow one is not waited for.
 */
export function hasUnsentEdits(shareId?: string): Promise<boolean> {
  if (unsentHere(shareId) > 0) return Promise.resolve(true);
  const ask = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      answers.delete(ask);
      resolve(false);
    }, ASK_TIMEOUT_MS);
    answers.set(ask, () => {
      clearTimeout(timer);
      answers.delete(ask);
      resolve(true);
    });
    broadcast({ type: "unsent?", ask, shareId });
  });
}

// deleting

/**
 * Deletions IndexedDB has not finished, by database. One that stopped being waited for still runs
 * once the connections that block it close, and would delete a copy opened meanwhile.
 */
const deleting = new Map<string, number>();

/** Sends one deletion; resolves when IndexedDB finished it, however long that takes. */
function requestDeletion(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(false);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      return resolve(false);
    }
    deleting.set(name, (deleting.get(name) ?? 0) + 1);
    const finish = (ok: boolean) => {
      const running = (deleting.get(name) ?? 1) - 1;
      if (running > 0) deleting.set(name, running);
      else deleting.delete(name);
      resolve(ok);
    };
    request.onsuccess = () => finish(true);
    request.onerror = () => finish(false);
  });
}

/** Deletes one IndexedDB database. False when it stayed (blocked, denied, no IndexedDB). */
export function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    // A blocked delete completes once the other connections close; do not wait forever.
    const timer = setTimeout(() => resolve(false), DELETE_TIMEOUT_MS);
    void requestDeletion(name).then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/**
 * Deletes the copy of a share whose document stays open and starts over (a resync). Resolves when
 * IndexedDB finished, however late; until then no copy of it is written (mayKeepCopy). A deletion
 * that failed stays due and is reported, like any copy that stayed.
 */
export async function dropCopy(shareId: string): Promise<boolean> {
  const ok = await requestDeletion(idbName(shareId));
  if (!ok) {
    due.ids.add(shareId);
    mark(ERASE + shareId);
    reportLeftovers();
  }
  return ok;
}

async function deleteWithRetry(name: string): Promise<boolean> {
  return (await deleteDatabase(name)) || (await deleteDatabase(name));
}

/** Deletes the copies of these shares and unlists the ones that went. True when all of them went. */
async function deleteCopies(ids: string[]): Promise<boolean> {
  const results = await Promise.all(
    ids.map(async (id) => {
      const current = await deleteWithRetry(idbName(id));
      const other = idbName(id).startsWith(IDB_PREFIX) ? LEGACY_IDB_PREFIX : IDB_PREFIX;
      return (await deleteWithRetry(other + id)) && current;
    }),
  );
  ids.forEach((id, i) => {
    if (!results[i]) return;
    // Allowed again meanwhile (yes in another tab): it may be there anew, so it stays listed.
    if (!mayKeepCopy(id)) unmark(COPY + id);
    unmark(ERASE + id);
    due.ids.delete(id);
  });
  return results.every(Boolean);
}

/**
 * Every share whose database may exist: `indexedDB.databases()` where it works, the registry,
 * deletions still due and open documents. `complete` is false when a copy from before the
 * registry could be missing: only a successful `databases()`, here or once before, rules that out.
 */
async function knownCopies(): Promise<{ ids: string[]; complete: boolean }> {
  const ids = new Set<string>();
  let enumerated = false;
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      for (const info of await indexedDB.databases()) {
        for (const prefix of [IDB_PREFIX, LEGACY_IDB_PREFIX]) {
          if (info.name?.startsWith(prefix)) ids.add(info.name.slice(prefix.length));
        }
      }
      enumerated = true;
    }
  } catch {
    // `databases()` refused: only the lists below are known.
  }
  let complete = enumerated;
  // Read after the wait, so a copy listed meanwhile (here or in another tab) is in too.
  for (const id of [...due.ids, ...[...holders].map((holder) => holder.shareId)]) ids.add(id);
  try {
    for (const id of [...storedIds(COPY), ...storedIds(ERASE)]) ids.add(id);
    if (enumerated) mark(COMPLETE_KEY);
    else complete = readMigratedKey(COMPLETE_KEY) !== null;
  } catch {
    // Blocked storage: no copy could be listed, nor created (noteCopy).
  }
  return { ids: [...ids], complete };
}

/**
 * Deletes every copy that may not be kept: all of them while the device choice is not yes or
 * every copy has to go, forgotten shares, deletions not confirmed yet. The erase-all mark stays
 * until a deletion of every known copy worked, so the next start tries again.
 */
async function cleanup(): Promise<{ deleted: boolean; complete: boolean }> {
  const all = eraseAllDue();
  const { ids, complete } = await knownCopies();
  const deleted = await deleteCopies(ids.filter((id) => !mayKeepCopy(id)));
  if (deleted && all) {
    due.all = false;
    unmark(ERASE_ALL_KEY);
  }
  return { deleted, complete };
}

/** Deletes every copy. True only when the list was complete and every copy on it went. */
async function eraseAll(): Promise<boolean> {
  markEraseAll();
  const { deleted, complete } = await cleanup();
  return deleted && complete;
}

/**
 * Deletes what is due at start. A copy that could not be deleted is reported; one that may be
 * missing from an incomplete list is not, it is reported by the cleanups that promise all copies.
 */
export async function sweep(): Promise<boolean> {
  if (isStorageMigrationBlocked()) {
    reportLeftovers();
    return false;
  }
  const { deleted } = await cleanup();
  if (!deleted) reportLeftovers();
  return deleted;
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
  // No copy of it is written meanwhile, here or in another tab.
  due.ids.add(shareId);
  mark(ERASE + shareId);
  if (options.broadcast !== false) broadcast({ type: "share", shareId });
  await closeDocuments(shareId);
  dropKey(shareId);
  return deleteCopies([shareId]);
}

/** The server's refusal: leave the share; a copy that stayed is reported. */
export function leaveAfterDenial(shareId: string): Promise<boolean> {
  return leaveShare(shareId).then((ok) => {
    if (!ok) reportLeftovers();
    return ok;
  });
}

/**
 * A PIN or approval asked for at the door of a share this device may hold a copy of: the copy
 * goes before the gate shows, the same as when it is asked for while the share is open.
 */
export function leaveBeforeChallenge(shareId: string, keyRemembered: boolean): Promise<boolean> {
  if (!keyRemembered && !mayHoldCopy(shareId)) return Promise.resolve(true);
  return leaveAfterDenial(shareId);
}

/**
 * "Forget on this device": leave the share, and keep no copy of it until the user asks again.
 * When that cannot be stored, no share keeps a copy on this device, and it reports a failure.
 */
export async function forgetShare(shareId: string): Promise<boolean> {
  let recorded = mark(FORGOTTEN + shareId);
  const left = await leaveShare(shareId);
  // The deletions may have made room for it.
  recorded ||= mark(FORGOTTEN + shareId);
  if (recorded) return left;
  await chooseOfflineCopy("no");
  return false;
}

/**
 * The device choice. Yes also takes back "Forget" for the share in view; no deletes every copy,
 * including those of shares no tab has open. False when copies may have stayed.
 */
export async function chooseOfflineCopy(choice: "yes" | "no", shareId?: string): Promise<boolean> {
  if (choice === "yes") {
    if (shareId) unmark(FORGOTTEN + shareId);
    setPrefs({ offlineCopy: "yes" });
    return true;
  }
  // Open documents close their copies on the change (here and, by the storage event, elsewhere).
  const stored = setPrefs({ offlineCopy: "no" });
  await Promise.all([...holders].map((holder) => within(holder.releaseLocal(), CLOSE_TIMEOUT_MS)));
  const { deleted, complete } = await cleanup();
  return stored && deleted && complete;
}

/** Forgets every share of this browser: open documents, offline copies and remembered keys. */
export async function forgetAll(options: { broadcast?: boolean } = {}): Promise<boolean> {
  markEraseAll();
  if (options.broadcast !== false) broadcast({ type: "all" });
  await closeDocuments();
  dropAllKeys();
  return eraseAll();
}

/**
 * Logout: every open document is torn down first, then the server forgets the identity and issues
 * a new session, then this browser deletes the rest.
 */
export async function signOut(): Promise<boolean> {
  markEraseAll();
  broadcast({ type: "all" });
  await closeDocuments();
  dropAllKeys();
  let loggedOut = true;
  try {
    await api.logout();
  } catch {
    loggedOut = false;
  }
  const forgotten = await eraseAll();
  unmark(SUBJECT_KEY);
  queryClient.clear();
  return loggedOut && forgotten;
}

/** This browser has seen a session before, so a changed identity can still be noticed. */
export function hasSeenSession(): boolean {
  try {
    return readMigratedKey(SUBJECT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Account switching: login and logout rotate the session's clientId, and an anonymous session
 * that was replaced has a new one too. The tab that sees a clientId other than the one this device
 * saw last marks every copy for deletion, stores the new one, tells the other tabs (they close
 * their documents and reload) and deletes every copy before the session is handed out. When that
 * fails, the mark stays: no copy is written until a later cleanup succeeds, the new session works
 * from memory only, and the user is told once. Tabs do not acknowledge: a tab that is slow to
 * close keeps the database open, which makes the deletion fail and so keeps the mark.
 */
export async function noteSessionIdentity(session: SessionResponse): Promise<void> {
  let previous: string | null;
  try {
    previous = readMigratedKey(SUBJECT_KEY);
  } catch {
    // Blocked storage: no copy is ever written (noteCopy), so there is nothing to protect.
    return;
  }
  const changed = previous !== null && previous !== session.clientId;
  if (changed) markEraseAll();
  // Before the other tabs hear of it, so one that reloads finds this identity and does not start
  // over. Not stored: the next start sees the change again and repeats the cleanup.
  if (previous !== session.clientId) store(SUBJECT_KEY, session.clientId);
  if (changed) {
    broadcast({ type: "identity" });
    await closeDocuments();
    dropAllKeys();
  }
  if (eraseAllDue() && !(await eraseAll())) reportLeftovers();
}
