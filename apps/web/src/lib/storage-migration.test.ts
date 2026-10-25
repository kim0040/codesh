import { afterEach, expect, it, vi } from "vitest";
import { initializeLegacyDatabases, migrateStorage, mirrorStorageEvent } from "./storage-migration";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

// legacy codesh name (1.0.x); remove in 2.0
it("synchronously migrates all persistent and session keys, keeps new values and other apps", () => {
  const s = storage({
    "codesh.prefs": "prefs",
    "codesh.admin": "token",
    "codesh.tour": "1",
    "codesh.diagnostics.v1": "events",
    "codesh.device.copy:share": "1",
    "codesh.theme": "dark",
    "gachipad.theme": "light",
    unrelated: "keep",
  });
  migrateStorage(s);
  expect(s.getItem("gachipad.prefs")).toBe("prefs");
  expect(s.getItem("gachipad.admin")).toBe("token");
  expect(s.getItem("gachipad.tour")).toBe("1");
  expect(s.getItem("gachipad.diagnostics.v1")).toBe("events");
  expect(s.getItem("gachipad.device.copy:share")).toBe("1");
  expect(s.getItem("gachipad.theme")).toBe("light");
  expect(s.getItem("unrelated")).toBe("keep");
  s.removeItem("gachipad.admin");
  migrateStorage(s);
  expect(s.getItem("gachipad.admin")).toBeNull();
});

// legacy codesh name (1.0.x); remove in 2.0
it("retains the source and retries after a quota failure", () => {
  const s = storage({ "codesh.locale": "en" });
  const set = s.setItem;
  s.setItem = () => {
    throw new Error("quota");
  };
  expect(() => migrateStorage(s)).toThrow("quota");
  expect(s.getItem("codesh.locale")).toBe("en");
  s.setItem = set;
  migrateStorage(s);
  expect(s.getItem("gachipad.locale")).toBe("en");
});

// legacy codesh name (1.0.x); remove in 2.0
it("boot does not wait for an indexedDB.databases() that never settles", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("indexedDB", { databases: () => new Promise(() => {}) });
  const done = vi.fn();
  void initializeLegacyDatabases().then(done);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toHaveBeenCalledOnce();
  expect(localStorage.getItem("gachipad.legacy-storage")).toBeNull();
});

// legacy codesh name (1.0.x); remove in 2.0
it("a late databases() answer still marks the profile as legacy", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("indexedDB", {
    databases: () =>
      new Promise((resolve) => setTimeout(() => resolve([{ name: "codesh:doc:abc" }]), 1500)),
  });
  const boot = initializeLegacyDatabases();
  await vi.advanceTimersByTimeAsync(1000);
  await boot;
  expect(localStorage.getItem("gachipad.legacy-storage")).toBeNull();
  await vi.advanceTimersByTimeAsync(500);
  expect(localStorage.getItem("gachipad.legacy-storage")).toBe("1");
});

// legacy codesh name (1.0.x); remove in 2.0
it("a prompt databases() answer marks the profile before boot goes on", async () => {
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("indexedDB", { databases: async () => [{ name: "codesh:doc:abc" }] });
  await initializeLegacyDatabases();
  expect(localStorage.getItem("gachipad.legacy-storage")).toBe("1");
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("indexedDB", { databases: async () => [{ name: "gachipad:doc:abc" }] });
  await initializeLegacyDatabases();
  expect(localStorage.getItem("gachipad.legacy-storage")).toBeNull();
});

// legacy codesh name (1.0.x); remove in 2.0
it("mirrors an old tab's writes to the new keys, but not forget messages", () => {
  const s = storage();
  const event = (key: string, newValue: string | null) =>
    ({ key, newValue, storageArea: s }) as StorageEvent;
  mirrorStorageEvent(event("codesh.theme", "dark"));
  expect(s.getItem("gachipad.theme")).toBe("dark");
  mirrorStorageEvent(event("codesh.theme", null));
  expect(s.getItem("gachipad.theme")).toBeNull();
  mirrorStorageEvent(event("codesh.forget", '{"tab":"a"}'));
  expect(s.getItem("gachipad.forget")).toBeNull();
  mirrorStorageEvent(event("other.key", "x"));
  expect(s.getItem("gachipad.key")).toBeNull();
});
