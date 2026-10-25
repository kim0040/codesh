import { channels, verifyCollabToken } from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Client,
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
} from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

interface View {
  role: string | null;
  needsPin: boolean;
  requireApproval: boolean;
  title: string;
  access?: { editKey: string };
}

describe.skipIf(!integration)("join: edit key", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function viewOnlyShare() {
    const owner = h.client();
    const { id } = await createShare(owner);
    const view = (
      await owner.patch(`/api/shares/${id}`, { access: { default: "view" } })
    ).json<View>();
    return { owner, id, editKey: view.access?.editKey as string };
  }

  it("gives the default role without a key and edit with the share's key", async () => {
    const { id, editKey } = await viewOnlyShare();
    const guest = h.client();
    expect((await guest.post(`/api/shares/${id}/join`)).json<{ role: string }>().role).toBe("view");
    const withKey = await guest.post(`/api/shares/${id}/join`, { editKey });
    expect(withKey.json<{ role: string; token: string }>().role).toBe("edit");
    expect(
      (await verifyCollabToken(withKey.json<{ token: string }>().token, h.config.collabSecret))
        ?.role,
    ).toBe("edit");
  });

  it("ignores a wrong key", async () => {
    const { id } = await viewOnlyShare();
    const response = await h.client().post(`/api/shares/${id}/join`, { editKey: "wrong" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ role: string }>().role).toBe("view");
  });

  it("remembers an accepted key for reconnects, until the owner rotates it", async () => {
    const { owner, id, editKey } = await viewOnlyShare();
    const guest = h.client();
    await guest.post(`/api/shares/${id}/join`, { editKey });
    // A reconnect fetches a fresh token without sending the key again.
    expect((await guest.post(`/api/shares/${id}/join`)).json<{ role: string }>().role).toBe("edit");
    expect((await guest.get(`/api/shares/${id}`)).json<View>().role).toBe("edit");

    await owner.patch(`/api/shares/${id}`, { access: { rotateEditKey: true } });
    expect((await guest.post(`/api/shares/${id}/join`)).json<{ role: string }>().role).toBe("view");
    const rotated = (await owner.get(`/api/shares/${id}`)).json<View>().access?.editKey;
    expect(rotated).not.toBe(editKey);
    expect(
      (await guest.post(`/api/shares/${id}/join`, { editKey })).json<{ role: string }>().role,
    ).toBe("view");
    expect(
      (await guest.post(`/api/shares/${id}/join`, { editKey: rotated })).json<{ role: string }>()
        .role,
    ).toBe("edit");
  });
});

describe.skipIf(!integration)("join: PIN", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function protectedShare(pin = "482913") {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Secret title" });
    await owner.patch(`/api/shares/${id}`, { access: { pin } });
    return { owner, id };
  }

  it("hides the share until the PIN is entered: pin_required, pin_invalid, then a token", async () => {
    const { id } = await protectedShare();
    const guest = h.client();

    const view = (await guest.get(`/api/shares/${id}`)).json<View>();
    expect(view).toMatchObject({ role: null, needsPin: true, title: "" });

    const missing = await guest.post(`/api/shares/${id}/join`);
    expect(missing.statusCode).toBe(401);
    expect(errorCode(missing)).toBe("pin_required");

    const wrong = await guest.post(`/api/shares/${id}/join`, { pin: "000000" });
    expect(wrong.statusCode).toBe(403);
    expect(errorCode(wrong)).toBe("pin_invalid");

    const right = await guest.post(`/api/shares/${id}/join`, { pin: "482913" });
    expect(right.statusCode).toBe(200);
    expect(right.json<{ role: string }>().role).toBe("edit");

    // Admitted: no PIN needed again, and the share shows its title.
    expect((await guest.post(`/api/shares/${id}/join`)).statusCode).toBe(200);
    expect((await guest.get(`/api/shares/${id}`)).json<View>()).toMatchObject({
      role: "edit",
      needsPin: false,
      title: "Secret title",
    });
  });

  it("never asks the owner for the PIN", async () => {
    const { owner, id } = await protectedShare();
    expect((await owner.post(`/api/shares/${id}/join`)).json<{ role: string }>().role).toBe(
      "owner",
    );
  });

  it("blocks the sixth attempt of a client within 10 minutes with 429, even for the right PIN", async () => {
    const { id } = await protectedShare();
    const guest = h.client();
    const guestId = await guest.clientId();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const wrong = await guest.post(`/api/shares/${id}/join`, { pin: `99999${attempt}` });
      expect(wrong.statusCode, `attempt ${attempt}`).toBe(403);
      expect(errorCode(wrong)).toBe("pin_invalid");
    }
    const key = `pinfail:c:${id}:${guestId}`;
    expect(Number(await h.valkey.get(key))).toBe(5);
    const ttl = await h.valkey.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);

    const blocked = await guest.post(`/api/shares/${id}/join`, { pin: "482913" });
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(600);

    // Other clients, and other shares, are not affected.
    expect((await h.client().post(`/api/shares/${id}/join`, { pin: "482913" })).statusCode).toBe(
      200,
    );
    const other = await protectedShare("111111");
    expect((await guest.post(`/api/shares/${other.id}/join`, { pin: "111111" })).statusCode).toBe(
      200,
    );
  });

  it("counts parallel wrong PINs: five are checked, every other request gets 429", async () => {
    const { id } = await protectedShare();
    const guest = h.client();
    await guest.clientId();
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        guest.post(`/api/shares/${id}/join`, { pin: String(100000 + i) }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 403)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(35);
    // Refused attempts are not counted, so the counters stop at the limit.
    expect(Number(await h.valkey.get(`pinfail:c:${id}:${await guest.clientId()}`))).toBe(5);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "482913" })).statusCode).toBe(429);
  });

  it("gives the IP slot back after a correct PIN, so a classroom behind one IP is not locked out", async () => {
    const { id } = await protectedShare();
    const ip = h.client().ip;
    for (let i = 0; i < 40; i++) {
      const student = h.client({ ip });
      expect((await student.post(`/api/shares/${id}/join`, { pin: "482913" })).statusCode).toBe(
        200,
      );
    }
    expect(await h.valkey.get(`pinfail:i:${id}:${ip}`)).toBeNull();
  });

  it("does not let a guesser reset the limit by dropping the cookie", async () => {
    const { id } = await protectedShare();
    const ip = h.client().ip;
    for (let i = 0; i < 30; i++) {
      const fresh = h.client({ ip });
      expect((await fresh.post(`/api/shares/${id}/join`, { pin: "000001" })).statusCode).toBe(403);
    }
    const blocked = await h.client({ ip }).post(`/api/shares/${id}/join`, { pin: "482913" });
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe("rate_limited");
  }, 30_000);

  it("clears the wrong-attempt counter after a correct PIN", async () => {
    const { id } = await protectedShare();
    const guest = h.client();
    const guestId = await guest.clientId();
    await guest.post(`/api/shares/${id}/join`, { pin: "000000" });
    expect(Number(await h.valkey.get(`pinfail:c:${id}:${guestId}`))).toBe(1);
    await guest.post(`/api/shares/${id}/join`, { pin: "482913" });
    expect(await h.valkey.get(`pinfail:c:${id}:${guestId}`)).toBeNull();
  });

  it("hides title and preview in the saved list of a client that must enter the new PIN", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, {
      title: "Solutions",
      files: [{ path: "a.txt", content: "secret answer\n" }],
    });
    await owner.patch(`/api/shares/${id}`, { access: { pin: "482913" } });
    const guest = h.client();
    await guest.post(`/api/shares/${id}/join`, { pin: "482913" });
    await guest.post(`/api/shares/${id}/save`);
    const before = (await guest.get("/api/shares")).json<{ title: string; preview: string }[]>();
    expect(before[0]).toMatchObject({ title: "Solutions", preview: "secret answer" });

    await owner.patch(`/api/shares/${id}`, { access: { pin: "777777" } });
    const locked = await guest.get("/api/shares");
    expect(locked.body).not.toContain("secret answer");
    expect(locked.body).not.toContain("Solutions");
    expect(locked.json<{ id: string }[]>().map((s) => s.id)).toEqual([id]);

    await guest.post(`/api/shares/${id}/join`, { pin: "777777" });
    expect((await guest.get("/api/shares")).json<{ title: string }[]>()[0]?.title).toBe(
      "Solutions",
    );
  });

  it("makes everyone enter a new PIN, and removing the PIN opens the share", async () => {
    const { owner, id } = await protectedShare();
    const guest = h.client();
    await guest.post(`/api/shares/${id}/join`, { pin: "482913" });
    await owner.patch(`/api/shares/${id}`, { access: { pin: "777777" } });
    expect((await guest.post(`/api/shares/${id}/join`)).statusCode).toBe(401);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "482913" })).statusCode).toBe(403);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "777777" })).statusCode).toBe(200);

    await owner.patch(`/api/shares/${id}`, { access: { pin: null } });
    expect((await h.client().post(`/api/shares/${id}/join`)).statusCode).toBe(200);
  });

  it("keeps PIN-protected content away from actions that need admission", async () => {
    const { id } = await protectedShare();
    const guest = h.client();
    for (const [method, url] of [
      ["GET", `/api/shares/${id}/download`],
      ["POST", `/api/shares/${id}/fork`],
      ["POST", `/api/shares/${id}/save`],
    ] as const) {
      const response = await guest.request(method, url, method === "POST" ? { body: {} } : {});
      expect(response.statusCode, url).toBe(401);
      expect(errorCode(response)).toBe("pin_required");
    }
  });
});

describe.skipIf(!integration)("join: owner approval", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  async function approvalShare() {
    const owner = h.client();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, { access: { requireApproval: true } });
    return { owner, id };
  }

  const join = (client: Client, id: string) => client.post(`/api/shares/${id}/join`);

  it("answers 202 pending, lists the request for the owner, and admits after approval", async () => {
    const { owner, id } = await approvalShare();
    const guest = await h.client().named("Dana");
    const guestId = await guest.clientId();

    const pending = await join(guest, id);
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toEqual({ status: "pending" });
    expect(await h.valkey.hget(`pending:${id}`, guestId)).toBe("Dana");
    // Asking again does not create a second request.
    expect((await join(guest, id)).statusCode).toBe(202);
    expect(await h.valkey.hlen(`pending:${id}`)).toBe(1);

    const list = await owner.get(`/api/shares/${id}/pending`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ clientId: guestId, name: "Dana" }]);

    const view = (await guest.get(`/api/shares/${id}`)).json<View>();
    expect(view).toMatchObject({ role: null, requireApproval: true });

    const approved = await owner.post(`/api/shares/${id}/pending/${guestId}`, { approve: true });
    expect(approved.statusCode).toBe(200);
    expect(await h.valkey.hexists(`pending:${id}`, guestId)).toBe(0);

    const admitted = await join(guest, id);
    expect(admitted.statusCode).toBe(200);
    expect(admitted.json<{ role: string }>().role).toBe("edit");
    expect((await owner.get(`/api/shares/${id}/pending`)).json()).toEqual([]);
  });

  it("drops requests queued under the old PIN when the PIN changes", async () => {
    const { owner, id } = await approvalShare();
    await owner.patch(`/api/shares/${id}`, { access: { pin: "482913" } });
    const guest = h.client();
    const guestId = await guest.clientId();
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "482913" })).statusCode).toBe(202);
    expect((await owner.get(`/api/shares/${id}/pending`)).json<unknown[]>()).toHaveLength(1);

    await owner.patch(`/api/shares/${id}`, { access: { pin: "777777" } });
    expect((await owner.get(`/api/shares/${id}/pending`)).json<unknown[]>()).toEqual([]);
    const approve = await owner.post(`/api/shares/${id}/pending/${guestId}`, { approve: true });
    expect(approve.statusCode).toBe(404);
    // The guest has to know the new PIN to queue again.
    expect((await guest.post(`/api/shares/${id}/join`)).statusCode).toBe(401);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "777777" })).statusCode).toBe(202);
  });

  it("keeps a denied client out; it can ask again", async () => {
    const { owner, id } = await approvalShare();
    const guest = h.client();
    const guestId = await guest.clientId();
    await join(guest, id);
    expect(
      (await owner.post(`/api/shares/${id}/pending/${guestId}`, { approve: false })).statusCode,
    ).toBe(200);
    expect(await h.valkey.hexists(`pending:${id}`, guestId)).toBe(0);
    expect(await h.valkey.hexists(`grants:${id}`, guestId)).toBe(0);
    expect((await join(guest, id)).statusCode).toBe(202);
  });

  it("lets the owner in without approval", async () => {
    const { owner, id } = await approvalShare();
    expect((await join(owner, id)).json<{ role: string }>().role).toBe("owner");
  });

  it("checks the PIN first and does not ask for it again while waiting", async () => {
    const { owner, id } = await approvalShare();
    await owner.patch(`/api/shares/${id}`, { access: { pin: "2468" } });
    const guest = h.client();
    expect((await join(guest, id)).statusCode).toBe(401);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "0000" })).statusCode).toBe(403);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "2468" })).statusCode).toBe(202);
    // Waiting clients have passed the PIN; polling does not need it again.
    expect((await join(guest, id)).statusCode).toBe(202);
    await owner.post(`/api/shares/${id}/pending/${await guest.clientId()}`, { approve: true });
    expect((await join(guest, id)).statusCode).toBe(200);
  });

  it("answers pending_approval to actions of a client that is not admitted yet", async () => {
    const { id } = await approvalShare();
    const guest = h.client();
    await join(guest, id);
    const download = await guest.get(`/api/shares/${id}/download`);
    expect(download.statusCode).toBe(403);
    expect(errorCode(download)).toBe("pending_approval");
  });

  it("is for the owner only and answers 404 for an unknown request", async () => {
    const { owner, id } = await approvalShare();
    const guest = h.client();
    await join(guest, id);
    const guestId = await guest.clientId();
    const listDenied = await guest.get(`/api/shares/${id}/pending`);
    expect(listDenied.statusCode).toBe(403);
    expect(errorCode(listDenied)).toBe("forbidden");
    expect(
      (await guest.post(`/api/shares/${id}/pending/${guestId}`, { approve: true })).statusCode,
    ).toBe(403);
    const unknown = await owner.post(`/api/shares/${id}/pending/${await h.client().clientId()}`, {
      approve: true,
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
    expect(
      (await owner.post(`/api/shares/${id}/pending/not-a-uuid`, { approve: true })).statusCode,
    ).toBe(400);
  });
});

describe.skipIf(!integration)("kick and ban", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("kick tells collab, drops the grant and lets the client come back", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, { access: { pin: "1357" } });
    const guest = h.client();
    const guestId = await guest.clientId();
    await guest.post(`/api/shares/${id}/join`, { pin: "1357" });
    const perm = await h.subscribe(channels.perm(id));

    const response = await owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: false });
    expect(response.statusCode).toBe(200);
    expect(await eventually(() => perm.messages[0])).toMatchObject({
      kind: "kick",
      clientId: guestId,
    });
    expect((await h.stores.shares.get(id))?.bans).toEqual([]);
    // Versions are assigned and published in one step, so they arrive in order.
    await Promise.all([
      owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: false }),
      owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: false }),
    ]);
    await eventually(() => perm.messages[2]);
    const versions = perm.messages.map((m) => (m as { version: number }).version);
    const [first = 0] = versions;
    expect(versions).toEqual([first, first + 1, first + 2]);
    // The grant is gone, so the PIN is asked again; the client is not banned.
    expect((await guest.post(`/api/shares/${id}/join`)).statusCode).toBe(401);
    expect((await guest.post(`/api/shares/${id}/join`, { pin: "1357" })).statusCode).toBe(200);
    perm.stop();
  });

  it("ban records the client and refuses join, view and actions with banned", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const guest = h.client();
    const guestId = await guest.clientId();
    await guest.post(`/api/shares/${id}/join`);
    const perm = await h.subscribe(channels.perm(id));

    expect(
      (await owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: true })).statusCode,
    ).toBe(200);
    expect((await h.stores.shares.get(id))?.bans).toEqual([guestId]);
    expect(await eventually(() => perm.messages[0])).toMatchObject({
      kind: "kick",
      clientId: guestId,
    });

    for (const response of [
      await guest.post(`/api/shares/${id}/join`),
      await guest.get(`/api/shares/${id}`),
      await guest.get(`/api/shares/${id}/download`),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe("banned");
    }
    // Others are fine.
    expect((await h.client().post(`/api/shares/${id}/join`)).statusCode).toBe(200);
    perm.stop();
  });

  it("ban takes the share out of the banned client's saved shares and lets it expire", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, { title: "Private notes" });
    const guest = h.client();
    const guestId = await guest.clientId();
    await guest.post(`/api/shares/${id}/join`);
    await guest.post(`/api/shares/${id}/save`);
    expect(await h.stores.shares.get(id)).toMatchObject({ savedBy: [guestId], expiresAt: null });
    expect((await guest.get("/api/shares")).json<{ id: string }[]>().map((s) => s.id)).toEqual([
      id,
    ]);

    await owner.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: true });
    const share = await h.stores.shares.get(id);
    expect(share?.savedBy).toEqual([]);
    expect(share?.expiresAt).not.toBeNull();
    expect((await guest.get("/api/shares")).json()).toEqual([]);
  });

  it("leaves a banned client's older saved entry out of the list", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const guest = h.client();
    const guestId = await guest.clientId();
    await h.stores.shares.addSaved(id, guestId);
    await h.stores.shares.addBan(id, guestId);
    expect((await guest.get("/api/shares")).json()).toEqual([]);
    // Others who saved it are not affected.
    const other = h.client();
    await h.stores.shares.addSaved(id, await other.clientId());
    expect((await other.get("/api/shares")).json<{ id: string }[]>()).toHaveLength(1);
  });

  it("is for the owner only, cannot remove the owner, and validates the body", async () => {
    const owner = h.client();
    const ownerId = await owner.clientId();
    const { id } = await createShare(owner);
    const guest = h.client();
    const guestId = await guest.clientId();

    const denied = await guest.post(`/api/shares/${id}/kick`, { clientId: guestId, ban: true });
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("forbidden");

    const self = await owner.post(`/api/shares/${id}/kick`, { clientId: ownerId, ban: true });
    expect(self.statusCode).toBe(400);
    expect(errorCode(self)).toBe("validation");
    expect((await h.stores.shares.get(id))?.bans).toEqual([]);

    expect(
      (await owner.post(`/api/shares/${id}/kick`, { clientId: "nope", ban: true })).statusCode,
    ).toBe(400);
    expect(
      (await owner.post("/api/shares/Zz9Zz9Zz/kick", { clientId: guestId, ban: true })).statusCode,
    ).toBe(404);
  });
});
