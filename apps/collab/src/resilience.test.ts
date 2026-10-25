import {
  COLLAB_DENY_REASONS,
  COLLAB_MAX_PAYLOAD_BYTES,
  generateShareId,
  keys,
} from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  controlledStores,
  Harness,
  type StoreControl,
  servicesAvailable,
  sleep,
  storedText,
  ValkeyProxy,
  waitFor,
} from "./testing/harness.js";

const available = await servicesAvailable();

// Vitest fails the run on an unhandled rejection, so every test here also checks that the failure
// it injects does not escape as one (in production that would end the process).
describe.runIf(available)("collab resilience", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness?.close());

  const control = (): StoreControl => ({ down: false, calls: {} });
  const stored = (shareId: string, text: string) =>
    waitFor(
      async () => (await storedText(harness.stores, shareId)) === text,
      `stored "${text}"`,
      8000,
    );

  it("survives a MongoDB outage and catches up once it is back", async () => {
    const ctl = control();
    const server = await harness.startServer({ stores: controlledStores(harness.stores, ctl) });
    const share = await harness.createShare();
    const owner = await harness.connect(server.webSocketURL, share.id, { role: "owner" });
    const member = await harness.connect(server.webSocketURL, share.id, { role: "edit" });
    await Promise.all([owner.synced, member.synced]);
    owner.text.insert(0, "before;");
    await stored(share.id, "before;");

    ctl.down = true;
    const appends = ctl.calls["updates.append"] ?? 0;
    // The lock message cannot read the share now.
    await harness.stores.shares.update(share.id, { locked: true });
    await harness.publishPerm(share.id, { version: 1, kind: "lock" });
    member.text.insert(member.text.length, "during;");
    const late = await harness.connect(server.webSocketURL, share.id);
    expect(await late.denied).toBe(COLLAB_DENY_REASONS.unavailable);
    await sleep(2000);
    // Flushes back off: every 100 ms would be about 20 attempts.
    expect((ctl.calls["updates.append"] ?? 0) - appends).toBeLessThan(10);

    ctl.down = false;
    await stored(share.id, "before;during;");
    await waitFor(
      () =>
        member.stateless
          .filter((message) => (message as { type: string }).type === "locked")
          .some((m) => JSON.stringify(m).includes('"locked":true')),
      "lock applied after recovery",
    );
  });

  it("finishes a shutdown while MongoDB is down", async () => {
    const ctl = control();
    const server = await harness.startServer({ stores: controlledStores(harness.stores, ctl) });
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    client.text.insert(0, "unsaved");
    ctl.down = true;
    const started = Date.now();
    await server.destroy();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(server.server.hocuspocus.getDocumentsCount()).toBe(0);
    expect(await harness.redis.exists(keys.docLock(share.id))).toBe(0);
  });

  it("keeps recording through a Valkey outage and applies a ban it missed meanwhile", async () => {
    const proxy = await ValkeyProxy.start();
    // Only the reconnect re-reads the share here, not the periodic check.
    const server = await harness.startServer({
      valkeyUrl: proxy.url,
      timings: { reconcileMs: 600_000 },
    });
    const share = await harness.createShare();
    const owner = await harness.connect(server.webSocketURL, share.id, { role: "owner" });
    const member = await harness.connect(server.webSocketURL, share.id, { role: "edit" });
    await Promise.all([owner.synced, member.synced]);
    owner.text.insert(0, "before;");
    await stored(share.id, "before;");

    await proxy.down();
    await harness.stores.shares.addBan(share.id, member.clientId);
    await harness.publishPerm(share.id, { version: 1, kind: "kick", clientId: member.clientId });
    owner.text.insert(owner.text.length, "during;");
    await sleep(1000);
    expect(member.closes).toEqual([]);
    await proxy.up();

    await waitFor(() => member.closes.includes("kicked"), "missed ban applied", 10_000);
    await stored(share.id, "before;during;");
    expect(server.collab.docs.get(share.id)?.core.owner).toBe(true);
  });

  it("takes a lapsed doc lock back without giving up its buffer", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    client.text.insert(0, "one;");
    await stored(share.id, "one;");
    const state = server.collab.docs.get(share.id);
    if (!state) throw new Error("doc not loaded");
    let adopts = 0;
    const adopt = state.core.adopt.bind(state.core);
    state.core.adopt = () => {
      adopts++;
      return adopt();
    };
    let disowned = false;
    const watch = setInterval(() => {
      if (!state.core.owner) disowned = true;
    }, 2);

    // Valkey lost the key (restart without persistence, or the TTL ran out during a stall).
    await harness.redis.del(keys.docLock(share.id));
    client.text.insert(client.text.length, "two;");
    await waitFor(
      async () => (await harness.redis.get(keys.docLock(share.id))) !== null,
      "lock taken again",
    );
    clearInterval(watch);
    expect(disowned).toBe(false);
    expect(adopts).toBe(0);
    await stored(share.id, "one;two;");
  });

  it("hands the doc to the instance that took its lock over", async () => {
    const suffix = generateShareId();
    const a = await harness.startServer({ instanceId: `a-${suffix}` });
    const b = await harness.startServer({ instanceId: `b-${suffix}` });
    const share = await harness.createShare();
    const onA = await harness.connect(a.webSocketURL, share.id);
    await onA.synced;
    const onB = await harness.connect(b.webSocketURL, share.id);
    await onB.synced;
    await waitFor(() => a.collab.docs.get(share.id)?.core.owner === true, "A owns the doc");

    // A stalled for longer than the TTL and B took the lock meanwhile.
    await harness.redis.set(keys.docLock(share.id), `b-${suffix}`, "PX", 3000);
    await waitFor(
      () =>
        a.collab.docs.get(share.id)?.core.owner === false &&
        b.collab.docs.get(share.id)?.core.owner === true,
      "B took over",
    );
    onA.text.insert(0, "from A;");
    onB.text.insert(0, "from B;");
    await waitFor(
      () => onA.text.toString() === onB.text.toString() && onA.text.length === 14,
      "clients converge",
    );
    await stored(share.id, onA.text.toString());
  });

  it("applies perm messages that arrive while a connection is still loading the doc", async () => {
    const gates = new Map<string, { reached: boolean; open: () => void; opened: Promise<void> }>();
    const ctl = control();
    ctl.before = async (method, args) => {
      const gate = gates.get(String(args[0]));
      if (method !== "snapshots.latest" || !gate || gate.reached) return;
      gate.reached = true;
      await gate.opened;
    };
    const server = await harness.startServer({ stores: controlledStores(harness.stores, ctl) });
    const gate = (shareId: string) => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const entry = { reached: false, open, opened };
      gates.set(shareId, entry);
      return entry;
    };

    // Kicked after its token was checked, before it was on the doc.
    const kickShare = await harness.createShare();
    const kickGate = gate(kickShare.id);
    const kicked = await harness.connect(server.webSocketURL, kickShare.id);
    await waitFor(() => kickGate.reached, "kicked client loading");
    await harness.publishPerm(kickShare.id, {
      version: 1,
      kind: "kick",
      clientId: kicked.clientId,
    });
    await sleep(200);
    kickGate.open();
    await waitFor(() => kicked.closes.includes("kicked"), "kick applied after load");

    // Locked after the doc read `locked: false`.
    const lockShare = await harness.createShare();
    const lockGate = gate(lockShare.id);
    const member = await harness.connect(server.webSocketURL, lockShare.id, { role: "edit" });
    await waitFor(() => lockGate.reached, "member loading");
    await harness.stores.shares.update(lockShare.id, { locked: true });
    await harness.publishPerm(lockShare.id, { version: 1, kind: "lock" });
    await sleep(200);
    lockGate.open();
    await member.synced;
    await waitFor(
      () =>
        member.stateless.filter((message) => (message as { type: string }).type === "locked")
          .length > 0,
      "lock notice",
    );
    expect(
      member.stateless.filter((message) => (message as { type: string }).type === "locked"),
    ).toEqual([{ type: "locked", locked: true, readOnly: true }]);
    member.text.insert(0, "blocked");
    await sleep(300);
    expect(server.collab.docs.get(lockShare.id)?.document.getText("file:main").toString()).toBe("");
  });

  it("closes a doc whose share expired while it was loaded", async () => {
    const server = await harness.startServer({ timings: { lastActiveIntervalMs: 0 } });
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    client.text.insert(0, "first");
    await stored(share.id, "first");
    // What the TTL index does: the record goes, nobody publishes a delete.
    await harness.stores.shares.delete(share.id);
    client.text.insert(0, "lost? ");
    await waitFor(() => client.closes.includes("deleted"), "deleted close");
    await waitFor(() => !server.collab.docs.has(share.id), "doc dropped");
  });

  it("gives up the lock of a doc whose load did not complete", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    expect(await harness.redis.exists(keys.docLock(share.id))).toBe(1);
    // What a throwing afterLoadDocument hook leaves behind: Hocuspocus forgot the document.
    server.server.hocuspocus.documents.delete(share.id);
    await waitFor(() => !server.collab.docs.has(share.id), "state dropped");
    expect(await harness.redis.exists(keys.docLock(share.id))).toBe(0);
  });

  it("limits awareness: identity from the token, size, foreign clients and rate", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const a = await harness.connect(server.webSocketURL, share.id);
    const b = await harness.connect(server.webSocketURL, share.id);
    await Promise.all([a.synced, b.synced]);
    const awarenessOf = (client: typeof a) => {
      const awareness = client.provider.awareness;
      if (!awareness) throw new Error("no awareness");
      return awareness;
    };
    const serverAwareness = () => {
      const state = server.collab.docs.get(share.id);
      if (!state) throw new Error("doc not loaded");
      return state.document.awareness;
    };
    const spoofed = { clientId: "spoofed", name: "Mallory", color: "#000000" };

    awarenessOf(a).setLocalState({ user: spoofed, fileId: "main" });
    awarenessOf(b).setLocalState({ user: spoofed, fileId: "main" });
    await waitFor(
      () => awarenessOf(b).getStates().get(a.doc.clientID)?.fileId === "main",
      "awareness forwarded",
    );
    expect(awarenessOf(b).getStates().get(a.doc.clientID)?.user).toEqual({
      clientId: a.clientId,
      name: "Tester",
      color: "#336699",
    });
    await waitFor(() => serverAwareness().getStates().has(b.doc.clientID), "b announced");

    awarenessOf(a).setLocalStateField("blob", "x".repeat(5000));
    // A client of b's, forged by a with a newer clock.
    const forgedDoc = new Y.Doc();
    forgedDoc.clientID = b.doc.clientID;
    const forged = new Awareness(forgedDoc);
    for (let i = 0; i < 50; i++) forged.setLocalState({ user: spoofed, forged: i });
    applyAwarenessUpdate(awarenessOf(a), encodeAwarenessUpdate(forged, [b.doc.clientID]), "test");
    await sleep(300);
    expect(serverAwareness().getStates().get(a.doc.clientID)?.blob).toBeUndefined();
    expect(serverAwareness().getStates().get(b.doc.clientID)?.forged).toBeUndefined();
    forged.destroy();

    awarenessOf(a).setLocalState({ user: spoofed, fileId: "main" });
    await sleep(1100);
    let accepted = 0;
    const count = ({ updated }: { updated: number[] }) => {
      if (updated.includes(a.doc.clientID)) accepted++;
    };
    serverAwareness().on("update", count);
    for (let i = 0; i < 200; i++) awarenessOf(a).setLocalStateField("n", i);
    await sleep(300);
    serverAwareness().off("update", count);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(45);
  });

  it("closes a socket that sends a frame above the payload limit", async () => {
    const server = await harness.startServer();
    const socket = new WebSocket(`${server.webSocketURL}/collab`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.on("error", () => {});
    socket.send(new Uint8Array(COLLAB_MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    const response = await fetch(`${server.httpURL}/readyz`);
    expect(response.status).toBe(200);
  });
});
