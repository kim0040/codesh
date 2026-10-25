import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { onLeftovers } from "../device";
import { DocSession } from "./session";

/**
 * The offline copy across a resync, with the real device module and an IndexedDB that orders its
 * requests the way browsers do. Only the provider is replaced.
 */

interface Connection {
  closed: boolean;
  onversionchange: (() => void) | null;
  close(): void;
  write(update: Uint8Array): void;
  read(): Uint8Array[];
}

interface DbRequest {
  kind: "open" | "delete";
  asked?: boolean;
  result?: Connection;
  onsuccess?: () => void;
  onerror?: () => void;
}

/**
 * Requests on one database run one after the other. A deletion asks every connection to close
 * (`versionchange`) and waits until they did; an open queued behind it waits too. A database
 * holds the document updates written to it.
 */
function fakeIndexedDb(options: { deletionsFail?: boolean } = {}) {
  const stored = new Map<string, Uint8Array[]>();
  const queues = new Map<string, DbRequest[]>();
  const connections = new Map<string, Set<Connection>>();

  const open = (name: string) => connections.get(name) ?? new Set<Connection>();
  const connect = (name: string): Connection => {
    if (!stored.has(name)) stored.set(name, []);
    const connection: Connection = {
      closed: false,
      onversionchange: null,
      close() {
        if (connection.closed) return;
        connection.closed = true;
        open(name).delete(connection);
        pump(name);
      },
      write(update) {
        if (!connection.closed) stored.get(name)?.push(update);
      },
      read: () => [...(stored.get(name) ?? [])],
    };
    connections.set(name, open(name).add(connection));
    return connection;
  };

  function pump(name: string) {
    const queue = queues.get(name) ?? [];
    const request = queue[0];
    if (!request) return;
    if (request.kind === "delete" && open(name).size > 0) {
      if (!request.asked) {
        request.asked = true;
        for (const connection of open(name)) connection.onversionchange?.();
      }
      return;
    }
    queue.shift();
    if (request.kind === "open") request.result = connect(name);
    else if (!options.deletionsFail) stored.delete(name);
    queueMicrotask(() => {
      if (request.kind === "delete" && options.deletionsFail) request.onerror?.();
      else request.onsuccess?.();
      pump(name);
    });
  }

  const enqueue = (name: string, kind: DbRequest["kind"]): DbRequest => {
    const request: DbRequest = { kind };
    queues.set(name, [...(queues.get(name) ?? []), request]);
    queueMicrotask(() => pump(name));
    return request;
  };

  vi.stubGlobal("indexedDB", {
    open: (name: string) => enqueue(name, "open"),
    deleteDatabase: (name: string) => enqueue(name, "delete"),
  });
  return {
    stored,
    /** A connection that never answers `versionchange`: a frozen tab. */
    frozenTab: (name: string) => connect(name),
  };
}

/** y-indexeddb 9.0.12 on the fake: `destroy` waits for its open, `clearData` does not await its deletion. */
const fakes = vi.hoisted(() => {
  class Persistence {
    static made: Persistence[] = [];
    db: Connection | null = null;
    destroyed = false;
    readonly opened: Promise<Connection>;
    readonly whenSynced: Promise<Persistence>;
    constructor(
      readonly name: string,
      readonly doc: Y.Doc,
    ) {
      Persistence.made.push(this);
      this.opened = new Promise((resolve) => {
        const request = (indexedDB as unknown as { open(name: string): DbRequest }).open(name);
        request.onsuccess = () => {
          const db = request.result as Connection;
          db.onversionchange = () => db.close();
          resolve(db);
        };
      });
      this.whenSynced = this.opened.then((db) => {
        this.db = db;
        if (!this.destroyed) {
          db.write(Y.encodeStateAsUpdate(doc));
          Y.transact(
            doc,
            () => {
              for (const update of db.read()) Y.applyUpdate(doc, update);
            },
            this,
          );
        }
        return this;
      });
      doc.on("update", this.store);
    }
    private store = (update: Uint8Array, origin: unknown) => {
      if (this.db && origin !== this) this.db.write(update);
    };
    destroy() {
      this.doc.off("update", this.store);
      this.destroyed = true;
      return this.opened.then((db) => db.close());
    }
    clearData() {
      return this.destroy().then(() => {
        indexedDB.deleteDatabase(this.name);
      });
    }
  }
  class Provider {
    isAuthenticated = false;
    unsyncedChanges = 0;
    awareness = { setLocalStateField() {}, getLocalState: () => ({}), setLocalState() {} };
    attach() {}
    destroy() {}
    onOpen = async () => undefined;
  }
  return { Persistence, Provider };
});

vi.mock("@hocuspocus/provider", () => ({ HocuspocusProvider: fakes.Provider }));
vi.mock("y-indexeddb", () => ({ IndexeddbPersistence: fakes.Persistence }));
vi.mock("./socket", () => ({
  acquireSocket: () => ({ socket: { status: "connected" }, release: () => {} }),
}));

const user = { clientId: "c1", name: "Ada", color: "#000000" };

function open(shareId: string) {
  return new DocSession({ shareId, user, role: "edit", credentials: {} });
}

/** Lets queued IndexedDB requests and their callbacks run (setImmediate is not faked). */
async function settle() {
  await vi.advanceTimersByTimeAsync(10);
  await new Promise((resolve) => setImmediate(resolve));
}

async function reopened(name: string): Promise<string> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, doc);
  await settle();
  await persistence.whenSynced;
  await persistence.destroy();
  return doc.getText("t").toString();
}

let store: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fakes.Persistence.made = [];
  store = new Map([["gachipad.prefs", JSON.stringify({ offlineCopy: "yes" })]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the offline copy across a resync", () => {
  it("a deletion of the old copy that ends after the wait keeps the edits typed since", async () => {
    const idb = fakeIndexedDb();
    const name = "gachipad:doc:late";
    // A frozen tab keeps the copy open: an earlier deletion waits, and this tab's open behind it.
    const frozen = idb.frozenTab(name);
    indexedDB.deleteDatabase(name);
    const session = open("late");
    session.doc.getText("t").insert(0, "refused by the server");

    const resync = session.resync();
    await vi.advanceTimersByTimeAsync(4000);
    await resync;
    // The wait ran out: the document goes on from memory, and nothing opens the copy yet.
    expect(session.getState()).toMatchObject({ generation: 1, copyKept: false });
    expect(fakes.Persistence.made).toHaveLength(1);

    // The tab is gone: the old open, then the old copy's deletion finish after the new start.
    frozen.close();
    await settle();
    expect(fakes.Persistence.made).toHaveLength(2);
    expect(session.getState().copyKept).toBe(true);
    session.doc.getText("t").insert(0, "typed after the resync");
    expect(session.unsent()).toBeGreaterThan(0);

    session.destroy();
    await settle();
    expect(await reopened(name)).toBe("typed after the resync");
  });

  it("a deletion that fails keeps the document in memory and says a copy stayed", async () => {
    fakeIndexedDb({ deletionsFail: true });
    const told = vi.fn();
    const stop = onLeftovers(told);
    const session = open("stuck");
    await settle();

    await session.resync();
    await settle();
    expect(fakes.Persistence.made).toHaveLength(1);
    expect(session.getState()).toMatchObject({ generation: 1, copyKept: false });
    expect(store.has("gachipad.device.erase:stuck")).toBe(true);
    expect(told).toHaveBeenCalledTimes(1);
    session.destroy();
    stop();
  });
});
