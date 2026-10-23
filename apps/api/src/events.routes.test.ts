import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Client,
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
} from "./testing/harness.js";

interface Person {
  clientId: string;
  name: string;
  color: string;
  room: string | null;
}

const netOf = (client: Client) => `${client.ip.split(".").slice(0, 3).join(".")}.0/24`;

describe.skipIf(!integration)("GET /api/events", () => {
  let h: Harness;
  let base: string;
  let net: ReturnType<Harness["network"]>;
  beforeEach(() => {
    net = h.network();
  });
  const open: { close(): void }[] = [];
  beforeAll(async () => {
    h = await createHarness({ heartbeatMs: 60, presenceRefreshMs: 120 });
    base = await h.listen();
  });
  afterAll(async () => {
    for (const stream of open) stream.close();
    await h.close();
  });

  const stream = async (client: Client) => {
    const events = await client.events(base);
    open.push(events);
    return events;
  };

  it("opens an SSE stream with the security headers, a retry hint, heartbeats and the first lists", async () => {
    const client = await net.client().named("Ann");
    const events = await stream(client);
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(events.headers.get("cache-control")).toContain("no-cache");
    expect(events.headers.get("x-accel-buffering")).toBe("no");
    expect(events.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(events.headers.get("x-content-type-options")).toBe("nosniff");

    expect(await events.next("presence")).toEqual([]);
    expect(await events.next("nearby")).toEqual([]);
    await eventually(() => events.raw().includes(": heartbeat\n\n"));
    expect(events.raw().startsWith("retry: 3000\n\n")).toBe(true);
  });

  it("sets the cookie of a brand new visitor on the stream response", async () => {
    const response = await fetch(`${base}/api/events`, {
      headers: { "x-forwarded-for": h.client().ip },
    });
    expect(response.headers.get("set-cookie")).toMatch(/^codesh_sid=/);
    await response.body?.cancel();
  });

  it("keeps presence per network group and refreshes it while the stream is open", async () => {
    const ann = await net.client().named("Ann");
    const annId = await ann.clientId();
    const bob = await net.neighbour(ann, 201).named("Bob");
    const bobId = await bob.clientId();
    const far = await h.client({ ip: "172.30.99.5" }).named("Far");

    const annStream = await stream(ann);
    expect(await annStream.next("presence")).toEqual([]);
    expect(await h.valkey.zscore(`presence:${netOf(ann)}`, annId)).not.toBeNull();
    const card = await h.valkey.hgetall(`presence:user:${annId}`);
    expect(card).toMatchObject({ name: "Ann", net: netOf(ann), room: "" });
    expect(await h.valkey.ttl(`presence:user:${annId}`)).toBeGreaterThan(0);

    const bobStream = await stream(bob);
    const farStream = await stream(far);
    // Bob sees Ann in his first list; Ann is told about Bob. Neither sees themselves.
    const seenByBob = await bobStream.next("presence");
    expect(seenByBob.map((p: Person) => p.name)).toEqual(["Ann"]);
    const seenByAnn = await annStream.next("presence", (list) => list.length === 1);
    expect(seenByAnn).toEqual([
      { clientId: bobId, name: "Bob", color: expect.any(String), room: null },
    ]);
    // Another network group neither sees nor is seen.
    expect(await farStream.next("presence")).toEqual([]);
    expect(annStream.events.some((e) => (e.data as Person[]).some?.((p) => p.name === "Far"))).toBe(
      false,
    );

    // Presence is refreshed by the open stream: score moves on and an expired card comes back.
    const before = Number(await h.valkey.zscore(`presence:${netOf(ann)}`, annId));
    await h.valkey.del(`presence:user:${annId}`);
    await eventually(
      async () => Number(await h.valkey.zscore(`presence:${netOf(ann)}`, annId)) > before,
    );
    await eventually(async () => (await h.valkey.hget(`presence:user:${annId}`, "name")) === "Ann");
  });

  it("removes a client from the lists when its last stream closes, not before", async () => {
    const ann = await net.client().named("Ann2");
    const bob = await net.neighbour(ann, 202).named("Bob2");
    const bobId = await bob.clientId();
    const annStream = await stream(ann);
    await annStream.next("presence");
    const first = await stream(bob);
    const second = await stream(bob);
    await annStream.next("presence", (list) => list.some((p: Person) => p.clientId === bobId));

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await h.valkey.zscore(`presence:${netOf(bob)}`, bobId)).not.toBeNull();

    second.close();
    await annStream.next("presence", (list) => !list.some((p: Person) => p.clientId === bobId));
    expect(await h.valkey.zscore(`presence:${netOf(bob)}`, bobId)).toBeNull();
    expect(await h.valkey.exists(`presence:user:${bobId}`)).toBe(0);
  });

  it("pushes a renamed user to the others at once", async () => {
    const ann = await net.client().named("Ann3");
    const bob = await net.neighbour(ann, 203).named("Bob3");
    const annStream = await stream(ann);
    await stream(bob);
    await annStream.next("presence", (list) => list.some((p: Person) => p.name === "Bob3"));
    await bob.patch("/api/session", { name: "Robert", color: "#102030" });
    const list = await annStream.next("presence", (l) =>
      l.some((p: Person) => p.name === "Robert"),
    );
    expect(list.find((p: Person) => p.name === "Robert")?.color).toBe("#102030");
  });

  it("keeps a rename when the open stream refreshes the presence card", async () => {
    const ann = await net.client().named("Ann6");
    const bob = await net.neighbour(ann, 206).named("Before");
    const bobId = await bob.clientId();
    const annStream = await stream(ann);
    await stream(bob);
    await annStream.next("presence", (list) => list.some((p: Person) => p.name === "Before"));
    await bob.patch("/api/session", { name: "After" });
    await annStream.next("presence", (list) => list.some((p: Person) => p.name === "After"));
    // Several refresh ticks of Bob's stream (it still holds the session with the old name).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await h.valkey.hget(`presence:user:${bobId}`, "name")).toBe("After");
    const names = annStream.events
      .filter((e) => e.event === "presence")
      .flatMap((e) => (e.data as Person[]).map((p) => p.name));
    expect(names.slice(names.lastIndexOf("After") + 1)).not.toContain("Before");
  });

  it("delivers an invite to the chosen user only, with sender, title and note", async () => {
    const ann = await net.client().named("Ann4");
    const bob = await net.neighbour(ann, 204).named("Bob4");
    const cat = await net.neighbour(ann, 205).named("Cat4");
    const annId = await ann.clientId();
    const bobStream = await stream(bob);
    const catStream = await stream(cat);
    const { id } = await createShare(ann, { title: "Look at this", language: "go" });

    const response = await ann.post("/api/invites", {
      to: await bob.clientId(),
      shareId: id,
      note: "line 12 please",
    });
    expect(response.statusCode).toBe(200);
    const invite = await bobStream.next("invite");
    expect(invite).toEqual({
      from: { clientId: annId, name: "Ann4", color: expect.any(String) },
      shareId: id,
      title: "Look at this",
      language: "go",
      note: "line 12 please",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(catStream.events.some((e) => e.event === "invite")).toBe(false);
  });

  it("shows a share on every screen of the network group with a broadcast", async () => {
    const ann = await net.client().named("Ann5");
    const bob = await net.neighbour(ann, 206).named("Bob5");
    const far = await h.client({ ip: "172.31.5.5" }).named("Far5");
    const bobStream = await stream(bob);
    const annStream = await stream(ann);
    const farStream = await stream(far);
    const { id } = await createShare(ann, { title: "Lecture" });

    expect((await ann.post("/api/invites", { to: "net", shareId: id })).statusCode).toBe(200);
    const annId = await ann.clientId();
    for (const events of [bobStream, annStream]) {
      expect(await events.next("broadcast")).toEqual({
        from: { clientId: annId, name: "Ann5", color: expect.any(String) },
        shareId: id,
        title: "Lecture",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(farStream.events.some((e) => e.event === "broadcast")).toBe(false);
  });

  it("sends the owner an approval-request and the guest the result", async () => {
    const owner = await net.client().named("Owner6");
    const guest = await net.client().named("Guest6");
    const guestId = await guest.clientId();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, { access: { requireApproval: true } });
    const ownerStream = await stream(owner);
    const guestStream = await stream(guest);

    expect((await guest.post(`/api/shares/${id}/join`)).statusCode).toBe(202);
    expect(await ownerStream.next("approval-request")).toEqual({
      shareId: id,
      clientId: guestId,
      name: "Guest6",
    });
    // Asking again does not ring the owner twice.
    await guest.post(`/api/shares/${id}/join`);

    await owner.post(`/api/shares/${id}/pending/${guestId}`, { approve: true });
    expect(await guestStream.next("approval-result")).toEqual({ shareId: id, approved: true });
    expect(ownerStream.events.filter((e) => e.event === "approval-request")).toHaveLength(1);

    const other = await net.client().named("Other6");
    const otherStream = await stream(other);
    await other.post(`/api/shares/${id}/join`);
    await owner.post(`/api/shares/${id}/pending/${await other.clientId()}`, { approve: false });
    expect(await otherStream.next("approval-result")).toEqual({ shareId: id, approved: false });
  });

  it("tells a kicked client whether it was banned", async () => {
    const owner = h.client();
    const guest = h.client();
    const guestId = await guest.clientId();
    const { id } = await createShare(owner);
    await guest.post(`/api/shares/${id}/join`);
    const guestStream = await stream(guest);

    await owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: false });
    expect(await guestStream.next("kicked")).toEqual({ shareId: id, banned: false });
    await owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: true });
    expect(await guestStream.next("kicked", (d) => d.banned)).toEqual({
      shareId: id,
      banned: true,
    });
  });

  it("lists nearby shares and pushes new ones while the stream is open", async () => {
    const ann = await net.client().named("Ann7");
    const annStream = await stream(ann);
    expect(await annStream.next("nearby")).toEqual([]);
    const owner = net.neighbour(ann, 207);
    const { id } = await createShare(owner, {
      title: "Open for all",
      language: "rust",
      files: [{ path: "m.rs", content: "fn main() {}\n" }],
    });
    const list = await annStream.next("nearby", (items) => items.some((i) => i.id === id));
    expect(list.find((i) => i.id === id)).toEqual({
      id,
      title: "Open for all",
      language: "rust",
      participants: 0,
      preview: "fn main() {}",
    });
  });

  it("asks for the nearby list once per network group, not once per stream and tick", async () => {
    const shared = await createHarness({ presenceRefreshMs: 40, nearbyCacheMs: 60_000 });
    const url = await shared.listen();
    const group = shared.network();
    const streams: { close(): void }[] = [];
    try {
      const first = group.client();
      await createShare(first, { title: "Visible" });
      let lookups = 0;
      const original = shared.stores.shares.existing.bind(shared.stores.shares);
      shared.stores.shares.existing = async (ids) => {
        lookups++;
        return original(ids);
      };
      const clients = [first, group.client(), group.client(), group.client()];
      const opened = await Promise.all(clients.map((client) => client.events(url)));
      streams.push(...opened);
      for (const events of opened) {
        expect(await events.next("nearby")).toMatchObject([{ title: "Visible" }]);
      }
      // Many refresh ticks of four streams.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(lookups).toBe(1);
    } finally {
      for (const events of streams) events.close();
      await shared.close();
    }
  });

  it("ends open streams when the server closes", async () => {
    const own = await createHarness();
    const url = await own.listen();
    const client = own.client();
    await client.get("/api/session");
    const events = await (await import("./testing/harness.js")).openEventStream(url, {
      cookie: client.cookieHeader,
      "x-forwarded-for": client.ip,
    });
    await events.next("presence");
    const clientId = await client.clientId();
    expect(await own.valkey.zscore("presence:all", clientId)).not.toBeNull();
    const closing = own.close();
    // Closing the app ends the stream by itself instead of waiting for the client to leave.
    await Promise.race([
      events.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream still open")), 3000)),
    ]);
    await closing;
  });
});
