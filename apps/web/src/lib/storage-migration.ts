// legacy codesh name (1.0.x); remove in 2.0
export const LEGACY_STORAGE_PREFIX = "codesh.";
// legacy codesh name (1.0.x); remove in 2.0
export const LEGACY_IDB_PREFIX = "codesh:doc:";
const LEGACY_MARKER = "gachipad.legacy-storage";
let migrationBlocked = false;

export function isStorageMigrationBlocked(): boolean {
  return migrationBlocked;
}

export function readMigratedKey(key: string): string | null {
  return (
    localStorage.getItem(key) ??
    localStorage.getItem(LEGACY_STORAGE_PREFIX + key.slice("gachipad.".length))
  );
}

/** Copy once; a quota/denied write leaves the source intact for the next start. */
export function migrateStorage(storage: Storage): void {
  if (storage.getItem("gachipad.storage-migrated.v1") === "1") return;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const next = `gachipad.${key.slice(LEGACY_STORAGE_PREFIX.length)}`;
    if (storage.getItem(next) === null) storage.setItem(next, value);
    // Keep old tabs' markers reachable; the completed marker prevents stale-value resurrection.
    storage.setItem(LEGACY_MARKER, "1");
  }
  storage.setItem("gachipad.storage-migrated.v1", "1");
}

export function usesLegacyStorage(): boolean {
  try {
    return (
      localStorage.getItem(LEGACY_MARKER) === "1" ||
      localStorage.getItem(`${LEGACY_STORAGE_PREFIX}prefs`) !== null
    );
  } catch {
    return false;
  }
}

/** Old and new tabs share deletion/identity decisions throughout the 1.x compatibility window. */
export function mirrorLegacy(key: string, value: string | null): void {
  if (!usesLegacyStorage()) return;
  const old = LEGACY_STORAGE_PREFIX + key.slice("gachipad.".length);
  if (value === null) localStorage.removeItem(old);
  else localStorage.setItem(old, value);
}

/** Longest the first screen waits for `indexedDB.databases()`; an answer after that still counts. */
const DATABASES_WAIT_MS = 1000;

export async function initializeLegacyDatabases(waitMs = DATABASES_WAIT_MS): Promise<void> {
  const detect = (async () => {
    // Existing Yjs databases stay in place: copying a live database would split concurrent tabs.
    if ((await indexedDB.databases()).some((db) => db.name?.startsWith(LEGACY_IDB_PREFIX))) {
      localStorage.setItem(LEGACY_MARKER, "1");
    }
  })().catch(() => {
    // Browsers without enumeration use the synchronously migrated device registry/prefs.
  });
  // Some browsers never settle databases(): boot goes on, the marker is still set if it answers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    detect,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
}

// This module is the first import of main.tsx, before any module reads persisted preferences.
for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof window === "undefined") break;
  try {
    if (globalThis[name]) migrateStorage(globalThis[name]);
  } catch {
    // Blocked storage: preserve every source and retry on the next page load.
    migrationBlocked = true;
  }
}

/** Old tabs write `codesh.*`; the new keys follow, except `forget`, which device.ts hears on both. */
export function mirrorStorageEvent(event: StorageEvent): void {
  if (!event.key?.startsWith(LEGACY_STORAGE_PREFIX) || !event.storageArea) return;
  if (event.key === `${LEGACY_STORAGE_PREFIX}forget`) return;
  try {
    const key = `gachipad.${event.key.slice(LEGACY_STORAGE_PREFIX.length)}`;
    if (event.newValue === null) event.storageArea.removeItem(key);
    else event.storageArea.setItem(key, event.newValue);
  } catch {
    // Blocked storage; a later reload retries migration.
  }
}

if (typeof window !== "undefined") window.addEventListener("storage", mirrorStorageEvent);
