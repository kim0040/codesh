import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory localStorage and an IndexedDB that only lists and deletes databases. */
function fakeBrowser(options: { databases?: "missing" | "rejects"; blocked?: string[] } = {}) {
  const store = new Map<string, string>();
  const dbs = new Set<string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("window", { addEventListener: () => {}, location: { replace: () => {} } });
  const indexedDB: Record<string, unknown> = {
    deleteDatabase(name: string) {
      const request: { onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (options.blocked?.includes(name)) return request.onerror?.();
        dbs.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
  if (options.databases !== "missing") {
    indexedDB.databases = async () => {
      if (options.databases === "rejects") throw new Error("SecurityError");
      return [...dbs].map((name) => ({ name, version: 1 }));
    };
  }
  vi.stubGlobal("indexedDB", indexedDB);
  return { store, dbs };
}

async function load() {
  vi.resetModules();
  const device = await import("./device");
  const prefs = await import("./prefs");
  return { ...device, ...prefs };
}

/** What a DocSession does before it opens a copy. */
function createCopy(
  m: Awaited<ReturnType<typeof load>>,
  dbs: Set<string>,
  shareId: string,
): boolean {
  if (!m.noteCopy(shareId)) return false;
  dbs.add(m.idbName(shareId));
  return true;
}

describe("device choice", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps no copy until it is answered yes", async () => {
    const { store, dbs } = fakeBrowser();
    const m = await load();
    expect(m.getPrefs().offlineCopy).toBe("undecided");
    expect(createCopy(m, dbs, "shareA")).toBe(false);
    await m.chooseOfflineCopy("yes");
    expect(createCopy(m, dbs, "shareA")).toBe(true);
    expect(JSON.parse(store.get("codesh.device.copies") ?? "{}").ids).toEqual(["shareA"]);
  });

  it("no deletes the copies of shares no tab has open", async () => {
    const { dbs } = fakeBrowser();
    const m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    createCopy(m, dbs, "shareB");
    expect(await m.chooseOfflineCopy("no")).toBe(true);
    expect([...dbs]).toEqual([]);
  });

  it("forget keeps the share without a copy until the user turns copies on for it", async () => {
    const { dbs } = fakeBrowser();
    const m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    expect(await m.forgetShare("shareA")).toBe(true);
    expect([...dbs]).toEqual([]);
    expect(createCopy(m, dbs, "shareA")).toBe(false);
    expect(createCopy(m, dbs, "shareB")).toBe(true);
    await m.chooseOfflineCopy("yes", "shareA");
    expect(createCopy(m, dbs, "shareA")).toBe(true);
  });
});

describe("deleting every copy", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  for (const databases of ["missing", "rejects"] as const) {
    it(`finds closed copies through the registry when databases() is ${databases}`, async () => {
      const { dbs } = fakeBrowser({ databases });
      const m = await load();
      m.listenForForgetting();
      await m.chooseOfflineCopy("yes");
      createCopy(m, dbs, "shareA");
      createCopy(m, dbs, "shareB");
      expect(await m.forgetAll()).toBe(true);
      expect([...dbs]).toEqual([]);
    });
  }

  it("reports a failure when copies from before the registry cannot be listed", async () => {
    const { store, dbs } = fakeBrowser({ databases: "missing" });
    store.set("codesh.prefs", JSON.stringify({ offlineCopy: true }));
    dbs.add("codesh:doc:legacy");
    const m = await load();
    expect(await m.forgetAll()).toBe(false);
  });

  it("a deletion that failed blocks copies and is retried at the next start", async () => {
    const { store, dbs } = fakeBrowser({ blocked: ["codesh:doc:shareA"] });
    let m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    expect(await m.forgetAll()).toBe(false);
    expect(dbs.has("codesh:doc:shareA")).toBe(true);
    expect(m.mayKeepCopy("shareB")).toBe(false);

    // Next start, nothing holds the database any more.
    const saved = new Map(store);
    const next = fakeBrowser();
    for (const [key, value] of saved) next.store.set(key, value);
    next.dbs.add("codesh:doc:shareA");
    m = await load();
    expect(await m.sweep()).toBe(true);
    expect([...next.dbs]).toEqual([]);
    expect(m.mayKeepCopy("shareB")).toBe(true);
  });

  it("another session id on this device deletes the previous one's copies first", async () => {
    const { dbs } = fakeBrowser();
    const m = await load();
    const session = (clientId: string) => ({
      clientId,
      name: "Same name",
      color: "#000000",
      net: "n",
      room: null,
      identity: { provider: "oidc", name: "Same name" },
    });
    await m.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    await m.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    expect([...dbs]).toEqual(["codesh:doc:shareA"]);
    await m.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    expect([...dbs]).toEqual([]);
  });
});
