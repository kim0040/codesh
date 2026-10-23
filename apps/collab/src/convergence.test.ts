import { generateShareId } from "@codesh/shared";
import { createTestDatabase, mongoAvailable, type TestDatabase } from "@codesh/storage/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadPersisted, PersistedDoc } from "./persisted-doc.js";

/**
 * PLAN §4.3 concurrency check: clients edit the same region concurrently while messages are
 * reordered, connections drop and the server restarts from what it persisted. Afterwards every
 * replica and the stored state must be identical.
 */

const available = await mongoAvailable();
const RUNS = process.env.CI ? 1000 : 150;

type Command =
  | { kind: "insert"; client: number; at: number; text: string }
  | { kind: "delete"; client: number; at: number; length: number }
  | { kind: "meta"; client: number; value: string }
  | { kind: "deliver"; pick: number }
  | { kind: "disconnect"; client: number }
  | { kind: "reconnect"; client: number }
  | { kind: "flush" }
  | { kind: "compact" }
  | { kind: "restart"; flushFirst: boolean };

const client = fc.nat({ max: 4 });
// Positions near the start keep every client editing the same few characters.
const at = fc.nat({ max: 6 });
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("insert" as const),
      client,
      at,
      text: fc.string({ minLength: 1, maxLength: 4 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      client,
      at,
      length: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("meta" as const),
      client,
      value: fc.string({ maxLength: 3 }),
    }),
  },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("deliver" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("disconnect" as const), client }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reconnect" as const), client }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("flush" as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("compact" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("restart" as const), flushFirst: fc.boolean() }),
  },
);

interface Message {
  to: "server" | number;
  from: "server" | number;
  update: Uint8Array;
}

class Simulation {
  readonly clients: Y.Doc[];
  readonly connected: boolean[];
  /** In-flight messages; any of them may be delivered next. */
  network: Message[] = [];
  server!: Y.Doc;
  core!: PersistedDoc;

  constructor(
    readonly shareId: string,
    readonly database: TestDatabase,
    clientCount: number,
  ) {
    this.clients = Array.from({ length: clientCount }, (_, i) => {
      const doc = new Y.Doc();
      doc.clientID = i + 1;
      doc.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "remote" && this.connected[i]) {
          this.network.push({ from: i, to: "server", update });
        }
      });
      return doc;
    });
    this.connected = this.clients.map(() => true);
  }

  async startServer() {
    this.server = new Y.Doc({ gc: true });
    this.core = new PersistedDoc(this.shareId, this.server, this.database.stores, {
      compactAfter: 4,
      historyIntervalMs: 1_000_000,
    });
    this.core.owner = true;
    await this.core.load();
    // Like Hocuspocus: every applied update goes to every connected client, the sender included.
    // An update can integrate other clients' pending structs, and the sender needs those too.
    this.server.on("update", (update: Uint8Array) => {
      for (const [i, connected] of this.connected.entries()) {
        if (connected) this.network.push({ from: "server", to: i, update });
      }
    });
  }

  /** The Yjs sync handshake: both sides send what the other is missing. */
  sync(i: number) {
    const doc = this.clients[i] as Y.Doc;
    this.network.push(
      {
        from: "server",
        to: i,
        update: Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(doc)),
      },
      {
        from: i,
        to: "server",
        update: Y.encodeStateAsUpdate(doc, Y.encodeStateVector(this.server)),
      },
    );
  }

  deliver(message: Message) {
    if (message.to === "server") {
      if (message.from !== "server" && this.connected[message.from]) {
        Y.applyUpdate(this.server, message.update, message.from);
      }
    } else if (this.connected[message.to]) {
      Y.applyUpdate(this.clients[message.to] as Y.Doc, message.update, "remote");
    }
  }

  disconnect(i: number) {
    this.connected[i] = false;
    this.network = this.network.filter((m) => m.to !== i && m.from !== i);
  }

  async run(command: Command) {
    const n = this.clients.length;
    switch (command.kind) {
      case "insert": {
        const text = (this.clients[command.client % n] as Y.Doc).getText("file:main");
        text.insert(Math.min(command.at, text.length), command.text);
        return;
      }
      case "delete": {
        const text = (this.clients[command.client % n] as Y.Doc).getText("file:main");
        const start = Math.min(command.at, text.length);
        text.delete(start, Math.min(command.length, text.length - start));
        return;
      }
      case "meta":
        (this.clients[command.client % n] as Y.Doc).getMap("meta").set("title", command.value);
        return;
      case "deliver": {
        if (this.network.length === 0) return;
        const [message] = this.network.splice(command.pick % this.network.length, 1);
        if (message) this.deliver(message);
        return;
      }
      case "disconnect":
        this.disconnect(command.client % n);
        return;
      case "reconnect": {
        const i = command.client % n;
        if (this.connected[i]) return;
        this.connected[i] = true;
        this.sync(i);
        return;
      }
      case "flush":
        return this.core.flush();
      case "compact":
        return this.core.compact();
      case "restart": {
        // Unflushed updates are lost with the process; clients still have them and resend.
        if (command.flushFirst) await this.core.flush();
        await this.core.idle();
        this.core.detach();
        this.server.destroy();
        for (let i = 0; i < n; i++) this.disconnect(i);
        await this.startServer();
        return;
      }
    }
  }

  async settle() {
    for (let i = 0; i < this.clients.length; i++) {
      this.connected[i] = true;
      this.sync(i);
    }
    while (this.network.length > 0) this.deliver(this.network.shift() as Message);
    await this.core.flush();
  }
}

const snapshotOf = (doc: Y.Doc) => ({
  text: doc.getText("file:main").toString(),
  meta: doc.getMap("meta").toJSON(),
});

describe.runIf(available)("convergence under concurrency", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase("codesh_converge");
  });
  afterAll(() => database?.drop());

  it(`converges replicas and stored state (${RUNS} runs)`, async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 5 }),
        fc.array(command, { minLength: 10, maxLength: 80 }),
        async (clientCount, commands) => {
          runs++;
          const sim = new Simulation(generateShareId(), database, clientCount);
          await sim.startServer();
          for (const c of commands) await sim.run(c);
          await sim.settle();

          const expected = snapshotOf(sim.server);
          for (const doc of sim.clients) expect(snapshotOf(doc)).toEqual(expected);
          for (const doc of sim.clients) {
            expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(sim.server));
          }
          const loaded = await loadPersisted(database.stores, sim.shareId);
          const stored = new Y.Doc();
          if (loaded.state) Y.applyUpdate(stored, loaded.state);
          expect(snapshotOf(stored)).toEqual(expected);
          sim.core.detach();
        },
      ),
      { numRuns: RUNS },
    );
    console.log(`[measure] convergence property runs: ${runs}`);
    expect(runs).toBeGreaterThanOrEqual(RUNS);
  }, 600_000);
});
