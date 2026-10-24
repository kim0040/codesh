import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeOptions {
  databases?: "missing" | "rejects" | (() => Promise<{ name: string; version: number }[]>);
  blocked?: string[];
  /** setItem throws a QuotaExceededError for these key prefixes; reads keep working. */
  full?: string[];
  /** Another tab of the same browser: the same storage and databases. */
  shared?: { store: Map<string, string>; dbs: Set<string> };
}

/** In-memory localStorage and an IndexedDB that only lists and deletes databases. */
function fakeBrowser(options: FakeOptions = {}) {
  const store = options.shared?.store ?? new Map<string, string>();
  const dbs = options.shared?.dbs ?? new Set<string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.full?.some((prefix) => key.startsWith(prefix))) {
        throw new DOMException("full", "QuotaExceededError");
      }
      store.set(key, String(value));
    },
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  vi.stubGlobal("window", {
    addEventListener: () => {},
    location: { pathname: "/shareA", search: "", replace: vi.fn() },
  });
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
  const databases = options.databases;
  if (typeof databases === "function") indexedDB.databases = databases;
  else if (databases !== "missing") {
    indexedDB.databases = async () => {
      if (databases === "rejects") throw new Error("SecurityError");
      return [...dbs].map((name) => ({ name, version: 1 }));
    };
  }
  vi.stubGlobal("indexedDB", indexedDB);
  return { store, dbs };
}

/** A BroadcastChannel shared by the module instances of one test, as tabs of one browser. */
function fakeChannels() {
  const open = new Set<{ name: string; deliver: (data: unknown) => void }>();
  class Channel {
    private listener: ((event: { data: unknown }) => void) | null = null;
    private readonly entry: { name: string; deliver: (data: unknown) => void };
    constructor(name: string) {
      this.entry = { name, deliver: (data) => this.listener?.({ data }) };
      open.add(this.entry);
    }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
      this.listener = listener;
    }
    postMessage(data: unknown) {
      for (const other of open) {
        if (other !== this.entry && other.name === this.entry.name) {
          queueMicrotask(() => other.deliver(structuredClone(data)));
        }
      }
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
}

async function load() {
  vi.resetModules();
  const device = await import("./device");
  const prefs = await import("./prefs");
  return { ...device, ...prefs };
}

type Device = Awaited<ReturnType<typeof load>>;

/** What a DocSession does before it opens a copy. */
function createCopy(m: Device, dbs: Set<string>, shareId: string): boolean {
  if (!m.noteCopy(shareId)) return false;
  dbs.add(m.idbName(shareId));
  return true;
}

/** An earlier start where `indexedDB.databases()` worked: every copy since is in the registry. */
async function startedOnceWithDatabases(): Promise<{
  store: Map<string, string>;
  dbs: Set<string>;
}> {
  const browser = fakeBrowser();
  const m = await load();
  await m.sweep();
  return browser;
}

const session = (clientId: string) => ({
  clientId,
  name: "Same name",
  color: "#000000",
  net: "n",
  room: null,
  identity: { provider: "oidc" as const, name: "Same name" },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("device choice", () => {
  it("keeps no copy until it is answered yes", async () => {
    const { store, dbs } = fakeBrowser();
    const m = await load();
    expect(m.getPrefs().offlineCopy).toBe("undecided");
    expect(createCopy(m, dbs, "shareA")).toBe(false);
    await m.chooseOfflineCopy("yes");
    expect(createCopy(m, dbs, "shareA")).toBe(true);
    expect(store.get("codesh.device.copy:shareA")).toBe("1");
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

  it("forget that cannot store its record turns copies off for every share and reports it", async () => {
    const { store, dbs } = fakeBrowser({ full: ["codesh.device.forgotten:"] });
    const m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    createCopy(m, dbs, "shareB");
    expect(await m.forgetShare("shareA")).toBe(false);
    expect([...dbs]).toEqual([]);
    expect(m.getPrefs().offlineCopy).toBe("no");
    expect(JSON.parse(store.get("codesh.prefs") ?? "{}").offlineCopy).toBe("no");
    expect(createCopy(m, dbs, "shareA")).toBe(false);
    expect(createCopy(m, dbs, "shareB")).toBe(false);
  });
});

describe("deleting every copy", () => {
  for (const databases of ["missing", "rejects"] as const) {
    it(`finds closed copies through the registry when databases() is ${databases}`, async () => {
      const shared = await startedOnceWithDatabases();
      const { dbs } = fakeBrowser({ databases, shared });
      const m = await load();
      m.listenForForgetting();
      await m.chooseOfflineCopy("yes");
      createCopy(m, dbs, "shareA");
      createCopy(m, dbs, "shareB");
      expect(await m.forgetAll()).toBe(true);
      expect([...dbs]).toEqual([]);
    });
  }

  it("copies from before the registry that cannot be listed stay a failure, also after a start", async () => {
    const { store, dbs } = fakeBrowser({ databases: "missing" });
    store.set("codesh.prefs", JSON.stringify({ offlineCopy: true }));
    dbs.add("codesh:doc:legacy");
    const m = await load();
    const told = vi.fn();
    m.onLeftovers(told);
    expect(await m.sweep()).toBe(true);
    expect(await m.forgetAll()).toBe(false);
    expect(await m.forgetAll()).toBe(false);
    expect(await m.chooseOfflineCopy("no")).toBe(false);
    expect(store.has("codesh.device.complete")).toBe(false);
    expect([...dbs]).toEqual(["codesh:doc:legacy"]);
    // Nothing that had to go stayed behind a failed deletion: copies are not blocked for that.
    expect(told).not.toHaveBeenCalled();

    // Once the browser can list them, the old copy is found and deleted.
    fakeBrowser({ shared: { store, dbs } });
    const next = await load();
    expect(await next.forgetAll()).toBe(true);
    expect([...dbs]).toEqual([]);
    expect(store.get("codesh.device.complete")).toBe("1");
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
    fakeBrowser({ shared: { store, dbs } });
    m = await load();
    expect(await m.sweep()).toBe(true);
    expect([...dbs]).toEqual([]);
    expect(m.mayKeepCopy("shareB")).toBe(true);
  });

  it("a deletion that failed before the share was listed is retried without databases()", async () => {
    const shared = await startedOnceWithDatabases();
    const { store, dbs } = fakeBrowser({ databases: "missing", shared });
    store.set("codesh.device.erase:orphan", "1");
    dbs.add("codesh:doc:orphan");
    const m = await load();
    expect(m.mayKeepCopy("orphan")).toBe(false);
    expect(await m.sweep()).toBe(true);
    expect([...dbs]).toEqual([]);
    expect(store.has("codesh.device.erase:orphan")).toBe(false);
  });

  it("a copy listed while databases() is being read is not dropped from the registry", async () => {
    let answer: (list: { name: string; version: number }[]) => void = () => {};
    const { store, dbs } = fakeBrowser({
      databases: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    const swept = m.sweep();
    // Another tab lists and creates shareB meanwhile; the answer predates it.
    createCopy(m, dbs, "shareB");
    answer([{ name: "codesh:doc:shareA", version: 1 }]);
    expect(await swept).toBe(true);
    expect(store.get("codesh.device.copy:shareA")).toBe("1");
    expect(store.get("codesh.device.copy:shareB")).toBe("1");

    // A later cleanup that cannot list databases still knows both.
    fakeBrowser({ databases: "missing", shared: { store, dbs } });
    const next = await load();
    expect(await next.forgetAll()).toBe(true);
    expect([...dbs]).toEqual([]);
  });

  it("two tabs listing copies at the same time keep each other's entries", async () => {
    const shared = await startedOnceWithDatabases();
    fakeBrowser({ shared });
    const first = await load();
    await first.chooseOfflineCopy("yes");
    const second = await load();
    expect(createCopy(first, shared.dbs, "shareA")).toBe(true);
    expect(createCopy(second, shared.dbs, "shareB")).toBe(true);
    expect(createCopy(first, shared.dbs, "shareC")).toBe(true);
    for (const id of ["shareA", "shareB", "shareC"]) {
      expect(shared.store.get(`codesh.device.copy:${id}`)).toBe("1");
    }
  });

  it("a document that does not close in time does not hold the deletion up", async () => {
    vi.useFakeTimers();
    const { dbs } = fakeBrowser();
    const m = await load();
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    m.registerHolder({
      shareId: "shareA",
      releaseLocal: () => new Promise(() => {}),
      leave: () => new Promise(() => {}),
      unsent: () => 0,
    });
    const forgotten = m.forgetShare("shareA");
    await vi.advanceTimersByTimeAsync(m.CLOSE_TIMEOUT_MS);
    expect(await forgotten).toBe(true);
    expect([...dbs]).toEqual([]);
  });
});

describe("another account", () => {
  it("another session id on this device deletes the previous one's copies first", async () => {
    const { dbs } = fakeBrowser();
    const m = await load();
    await m.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    await m.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    expect([...dbs]).toEqual(["codesh:doc:shareA"]);
    await m.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    expect([...dbs]).toEqual([]);
    expect(m.mayKeepCopy("shareA")).toBe(true);
  });

  it("when the deletion fails, no copy is written, the new session goes on and it is said once", async () => {
    const { store, dbs } = fakeBrowser({ blocked: ["codesh:doc:shareA"] });
    let m = await load();
    await m.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    await m.chooseOfflineCopy("yes");
    createCopy(m, dbs, "shareA");
    const told = vi.fn();
    m.onLeftovers(told);
    await m.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    expect(store.get("codesh.device.subject")).toBe("bbbbbbbbbbbbbbbbbbbbbb");
    expect(dbs.has("codesh:doc:shareA")).toBe(true);
    expect(m.mayKeepCopy("shareB")).toBe(false);
    expect(createCopy(m, dbs, "shareB")).toBe(false);
    expect(told).toHaveBeenCalledTimes(1);
    // Retried with every session handed out; still blocked, still said only once.
    await m.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    expect(told).toHaveBeenCalledTimes(1);

    // A later start that can delete it lifts the block.
    fakeBrowser({ shared: { store, dbs } });
    m = await load();
    await m.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    expect([...dbs]).toEqual([]);
    expect(m.mayKeepCopy("shareB")).toBe(true);
  });

  it("the other tabs close their documents and reload; the tab that saw it deletes", async () => {
    fakeChannels();
    const shared = { store: new Map<string, string>(), dbs: new Set<string>() };
    fakeBrowser({ shared });
    const seeing = await load();
    await seeing.noteSessionIdentity(session("aaaaaaaaaaaaaaaaaaaaaa"));
    await seeing.chooseOfflineCopy("yes");
    createCopy(seeing, shared.dbs, "shareA");
    const other = await load();
    other.listenForForgetting();
    const leave = vi.fn(async () => undefined);
    other.registerHolder({
      shareId: "shareA",
      releaseLocal: async () => undefined,
      leave,
      unsent: () => 0,
    });
    await seeing.noteSessionIdentity(session("bbbbbbbbbbbbbbbbbbbbbb"));
    // The editor waits for the reload instead of going to the start page.
    expect(other.isRestarting()).toBe(true);
    expect(seeing.isRestarting()).toBe(false);
    await vi.waitFor(() => expect(window.location.replace).toHaveBeenCalledWith("/shareA"));
    expect(leave).toHaveBeenCalledTimes(1);
    expect([...shared.dbs]).toEqual([]);
    // A later change before the reload went through does not send it elsewhere.
    await seeing.noteSessionIdentity(session("cccccccccccccccccccccc"));
    expect(window.location.replace).toHaveBeenCalledTimes(1);
  });
});

describe("unsent edits", () => {
  it("are found in this tab and in another one", async () => {
    fakeChannels();
    const shared = { store: new Map<string, string>(), dbs: new Set<string>() };
    fakeBrowser({ shared });
    const here = await load();
    here.listenForForgetting();
    const other = await load();
    other.listenForForgetting();
    let unsent = 0;
    other.registerHolder({
      shareId: "shareA",
      releaseLocal: async () => undefined,
      leave: async () => undefined,
      unsent: () => unsent,
    });
    expect(await here.hasUnsentEdits("shareA")).toBe(false);
    unsent = 2;
    expect(await here.hasUnsentEdits("shareA")).toBe(true);
    expect(await here.hasUnsentEdits()).toBe(true);
    expect(await here.hasUnsentEdits("shareB")).toBe(false);
    expect(await other.hasUnsentEdits("shareA")).toBe(true);
  });
});
