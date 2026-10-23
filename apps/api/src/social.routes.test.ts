import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Client,
  createHarness,
  createShare,
  type Harness,
  integration,
} from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;
const netOf = (client: Client) => `${client.ip.split(".").slice(0, 3).join(".")}.0/24`;

describe.skipIf(!integration)("GET /api/presence", () => {
  let h: Harness;
  let net: ReturnType<Harness["network"]>;
  beforeEach(() => {
    net = h.network();
  });
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function online(client: Client, name: string) {
    await client.patch("/api/session", { name, color: "#334455" });
    const id = await client.clientId();
    await h.valkey.zadd(`presence:${netOf(client)}`, Date.now(), id);
    await h.valkey.hset(`presence:user:${id}`, {
      name,
      color: "#334455",
      net: netOf(client),
      room: "",
    });
    await h.valkey.expire(`presence:user:${id}`, 60);
    return id;
  }

  it("lists the other users online in my network group, by name", async () => {
    const me = net.client();
    const zed = net.neighbour(me, 31);
    const amy = net.neighbour(me, 32);
    const far = h.client({ ip: "172.29.1.1" });
    const meId = await online(me, "Me");
    const zedId = await online(zed, "Zed");
    const amyId = await online(amy, "Amy");
    await online(far, "Far");

    const response = await me.get("/api/presence");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { clientId: amyId, name: "Amy", color: "#334455", room: null },
      { clientId: zedId, name: "Zed", color: "#334455", room: null },
    ]);
    expect(response.json<{ clientId: string }[]>().some((u) => u.clientId === meId)).toBe(false);
  });

  it("drops users whose heartbeat is older than a minute or whose card expired", async () => {
    const me = net.client();
    const stale = net.neighbour(me, 41);
    const gone = net.neighbour(me, 42);
    const staleId = await online(stale, "Stale");
    const goneId = await online(gone, "Gone");
    await h.valkey.zadd(`presence:${netOf(me)}`, Date.now() - 61_000, staleId);
    await h.valkey.del(`presence:user:${goneId}`);
    const names = (await me.get("/api/presence")).json<{ name: string }[]>().map((u) => u.name);
    expect(names).not.toContain("Stale");
    expect(names).not.toContain("Gone");
  });

  it("shows the room name for users in a configured room", async () => {
    const me = net.client();
    await h.stores.settings.put({
      ...(await h.stores.settings.get()),
      rooms: [{ name: "Room 7", cidrs: [`${me.ip.split(".").slice(0, 3).join(".")}.0/24`] }],
    });
    const other = net.neighbour(me, 51);
    const otherId = await other.clientId();
    await other.patch("/api/session", { name: "Roomie" });
    await h.valkey.zadd("presence:Room 7", Date.now(), otherId);
    await h.valkey.hset(`presence:user:${otherId}`, {
      name: "Roomie",
      color: "#112233",
      net: "Room 7",
      room: "Room 7",
    });
    const list = (await me.get("/api/presence")).json<{ name: string; room: string | null }[]>();
    expect(list).toEqual([expect.objectContaining({ name: "Roomie", room: "Room 7" })]);
    await h.stores.settings.put({ ...(await h.stores.settings.get()), rooms: [] });
  });
});

describe.skipIf(!integration)("GET /api/nearby", () => {
  let h: Harness;
  let net: ReturnType<Harness["network"]>;
  beforeEach(() => {
    net = h.network();
  });
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("lists live shares of my network group with the card collab keeps", async () => {
    const owner = net.client();
    const { id } = await createShare(owner, { title: "Pairing", language: "ruby" });
    // Collab refreshes the card while people edit.
    await h.valkey.hset(`nearby:item:${id}`, {
      id,
      title: "Pairing",
      language: "ruby",
      participants: "3",
      preview: "puts 'hi'",
    });
    const neighbourClient = net.neighbour(owner, 77);
    const response = await neighbourClient.get("/api/nearby");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id, title: "Pairing", language: "ruby", participants: 3, preview: "puts 'hi'" },
    ]);
    expect((await h.client({ ip: "172.28.3.3" }).get("/api/nearby")).json()).toEqual([]);
  });

  it("forgets shares whose card expired, that were deleted, or that hide from nearby", async () => {
    const owner = net.client();
    const quiet = await createShare(owner, { title: "Quiet" });
    const deleted = await createShare(owner, { title: "Deleted" });
    const hidden = await createShare(owner, { title: "Hidden" });
    const shown = await createShare(owner, { title: "Shown" });
    await h.valkey.del(`nearby:item:${quiet.id}`);
    await h.stores.shares.delete(deleted.id);
    await owner.patch(`/api/shares/${hidden.id}`, { access: { nearby: false } });

    const list = (await owner.get("/api/nearby")).json<{ id: string }[]>();
    expect(list.map((i) => i.id)).toEqual([shown.id]);
    // Stale entries are pruned from the index as a side effect.
    expect(await h.valkey.zscore(`nearby:${netOf(owner)}`, quiet.id)).toBeNull();
    expect(await h.valkey.zscore(`nearby:${netOf(owner)}`, deleted.id)).toBeNull();
  });

  it("never announces shares of a lab student", async () => {
    const teacher = net.client();
    const lab = (await teacher.post("/api/labs", { title: "Lab" })).json<{ id: string }>();
    const student = net.neighbour(teacher, 88);
    const joined = await student.post(`/api/labs/${lab.id}/join`, { name: "Stu" });
    const { shareId } = joined.json<{ shareId: string }>();
    expect(await h.valkey.zscore(`nearby:${netOf(student)}`, shareId)).toBeNull();
    expect(
      (await teacher.get("/api/nearby")).json<{ id: string }[]>().map((i) => i.id),
    ).not.toContain(shareId);
  });
});

describe.skipIf(!integration)("POST /api/invites errors", () => {
  let h: Harness;
  let net: ReturnType<Harness["network"]>;
  beforeEach(() => {
    net = h.network();
  });
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function setup() {
    const ann = await net.client().named("Ann");
    const bob = await net.neighbour(ann, 61).named("Bob");
    const bobId = await bob.clientId();
    await h.valkey.zadd(`presence:${netOf(bob)}`, Date.now(), bobId);
    const { id } = await createShare(ann, { title: "T" });
    return { ann, bob, bobId, id };
  }

  it("answers 200 for an online user", async () => {
    const { ann, bobId, id } = await setup();
    const response = await ann.post("/api/invites", { to: bobId, shareId: id });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("answers 404 for an unknown share or a user who is not online in my group", async () => {
    const { ann, id } = await setup();
    expect(
      (await ann.post("/api/invites", { to: await h.client().clientId(), shareId: "Zz9Zz9Zz" }))
        .statusCode,
    ).toBe(404);
    const offline = await ann.post("/api/invites", {
      to: await h.client().clientId(),
      shareId: id,
    });
    expect(offline.statusCode).toBe(404);
    expect(errorCode(offline)).toBe("not_found");
    const far = h.client({ ip: "172.27.1.1" });
    const farId = await far.clientId();
    await h.valkey.zadd(`presence:${netOf(far)}`, Date.now(), farId);
    expect((await ann.post("/api/invites", { to: farId, shareId: id })).statusCode).toBe(404);
  });

  it("answers 400 for inviting yourself or a malformed body", async () => {
    const { ann, id } = await setup();
    const self = await ann.post("/api/invites", { to: await ann.clientId(), shareId: id });
    expect(self.statusCode).toBe(400);
    expect(errorCode(self)).toBe("validation");
    for (const body of [
      {},
      { to: "everyone", shareId: id },
      { to: "net" },
      { to: "net", shareId: id, note: "x".repeat(300) },
    ]) {
      expect((await ann.post("/api/invites", body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("lets only the owner show a share to the whole network group", async () => {
    const { bob, id } = await setup();
    const response = await bob.post("/api/invites", { to: "net", shareId: id });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe("forbidden");
  });

  it("does not let someone who cannot open a share send it around", async () => {
    const { ann, bobId, id } = await setup();
    await ann.patch(`/api/shares/${id}`, { access: { pin: "9090" } });
    const outsider = net.neighbour(ann, 62);
    const response = await outsider.post("/api/invites", { to: bobId, shareId: id });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe("pin_required");
  });
});
