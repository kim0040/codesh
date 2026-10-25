import { expect, it } from "vitest";
import { migrateStorage } from "./storage-migration";

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
