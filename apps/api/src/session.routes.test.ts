import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, integration } from "./testing/harness.js";

interface SessionBody {
  clientId: string;
  name: string | null;
  color: string;
  net: string;
  room: string | null;
}

describe.skipIf(!integration)("session routes", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("GET /api/session creates a signed httpOnly cookie and describes the visitor", async () => {
    const client = h.client();
    const response = await client.get("/api/session");
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionBody>();
    expect(body.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.name).toBeNull();
    expect(body.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(body.net).toBe(`${client.ip.split(".").slice(0, 3).join(".")}.0/24`);
    expect(body.room).toBeNull();

    const cookie = response.cookies.find((c) => c.name === "codesh_sid");
    expect(cookie).toBeDefined();
    // Signed: `<clientId>.<signature>`, and the raw id alone is not accepted.
    expect(decodeURIComponent(cookie?.value ?? "")).toMatch(new RegExp(`^${body.clientId}\\.`));
    expect(String(response.headers["set-cookie"])).toMatch(/HttpOnly/i);
    expect(String(response.headers["set-cookie"])).toMatch(/SameSite=Lax/i);
  });

  it("keeps the same clientId for the same cookie and issues no new cookie", async () => {
    const client = h.client();
    const first = await client.get("/api/session");
    const second = await client.get("/api/session");
    expect(second.json<SessionBody>().clientId).toBe(first.json<SessionBody>().clientId);
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("does not trust a forged or tampered cookie", async () => {
    const client = h.client();
    const real = (await client.get("/api/session")).json<SessionBody>().clientId;

    const forged = h.client();
    forged.setCookie("codesh_sid", real); // unsigned
    const unsigned = await forged.get("/api/session");
    expect(unsigned.json<SessionBody>().clientId).not.toBe(real);

    const tampered = h.client();
    tampered.setCookie("codesh_sid", `${real}.${"A".repeat(43)}`);
    const bad = await tampered.get("/api/session");
    expect(bad.json<SessionBody>().clientId).not.toBe(real);
    expect(bad.cookies.some((c) => c.name === "codesh_sid")).toBe(true);
  });

  it("PATCH /api/session stores name and color and returns them", async () => {
    const client = h.client();
    const { clientId } = (await client.get("/api/session")).json<SessionBody>();
    const response = await client.patch("/api/session", { name: "  Min  ", color: "#112233" });
    expect(response.statusCode).toBe(200);
    expect(response.json<SessionBody>()).toMatchObject({ clientId, name: "Min", color: "#112233" });

    expect(await h.valkey.hgetall(`profile:${clientId}`)).toEqual({
      name: "Min",
      color: "#112233",
    });
    expect((await client.get("/api/session")).json<SessionBody>()).toMatchObject({
      name: "Min",
      color: "#112233",
    });

    const partial = await client.patch("/api/session", { name: "Only name" });
    expect(partial.json<SessionBody>()).toMatchObject({ name: "Only name", color: "#112233" });
  });

  it("rejects an empty name, a long name and a bad color", async () => {
    const client = h.client();
    for (const body of [
      { name: "   " },
      { name: "x".repeat(41) },
      { color: "red" },
      { color: "#12345" },
    ]) {
      const response = await client.patch("/api/session", body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("validation");
    }
  });

  it("puts clients in a room when an admin configured the CIDR", async () => {
    const client = h.client();
    const settings = await h.stores.settings.get();
    await h.stores.settings.put({
      ...settings,
      rooms: [{ name: "Lab 301", cidrs: [`${client.ip.split(".").slice(0, 3).join(".")}.0/24`] }],
    });
    const body = (await client.get("/api/session")).json<SessionBody>();
    expect(body).toMatchObject({ net: "Lab 301", room: "Lab 301" });
    await h.stores.settings.put(settings);
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    const untrusting = await createHarness({ config: { trustProxy: [] } });
    try {
      const client = untrusting.client({ ip: "198.51.100.77" });
      const body = (await client.get("/api/session")).json<SessionBody>();
      // The socket address (127.0.0.1) decides, not the header.
      expect(body.net).toBe("127.0.0.0/24");
    } finally {
      await untrusting.close();
    }
  });

  it("marks the cookie Secure when the app is served over https", async () => {
    const secure = await createHarness({ config: { publicUrl: "https://gachipad.corp" } });
    try {
      const response = await secure.client().get("/api/session");
      expect(String(response.headers["set-cookie"])).toMatch(/; Secure/i);
      const plain = await h.client().get("/api/session");
      expect(String(plain.headers["set-cookie"])).not.toMatch(/; Secure/i);
    } finally {
      await secure.close();
    }
  });

  it("answers 403 forbidden to guests everywhere but /api/session when guests are off", async () => {
    const closed = await createHarness();
    try {
      const settings = await closed.stores.settings.get();
      await closed.stores.settings.put({ ...settings, guestAllowed: false });
      const client = closed.client();
      expect((await client.get("/api/session")).statusCode).toBe(200);
      const denied = await client.post("/api/shares");
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe("forbidden");
      expect((await client.get("/api/presence")).statusCode).toBe(403);
    } finally {
      await closed.close();
    }
  });
});
