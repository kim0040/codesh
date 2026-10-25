import { defaultSettings, keys } from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;
const bearer = (token = "admin-token-for-tests") => ({ authorization: `Bearer ${token}` });

describe.skipIf(!integration)("admin API", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  describe("authorization", () => {
    it("pauses global token comparisons across addresses, then resumes after the cooldown", async () => {
      const strict = await createHarness();
      try {
        for (let i = 0; i < 100; i++)
          expect((await strict.client().get("/api/admin/stats", bearer("guess"))).statusCode).toBe(
            403,
          );
        const paused = await strict.client().get("/api/admin/stats", bearer());
        expect(paused.statusCode).toBe(429);
        expect(Number(paused.headers["retry-after"])).toBeGreaterThan(0);
        // Advance the shared bucket's clock without waiting in real time.
        await strict.valkey.hset(
          keys.rateLimit("global", "admin-token-budget"),
          "pause",
          0,
          "at",
          Date.now() - 30_000,
        );
        expect((await strict.client().get("/api/admin/stats", bearer())).statusCode).toBe(200);
      } finally {
        await strict.close();
      }
    });

    it("keeps allowlisted administrators available even during a global pause", async () => {
      const strict = await createHarness({ config: { adminAllowCidr: ["10.0.0.0/8"] } });
      try {
        await strict.valkey.hset(
          keys.rateLimit("global", "admin-token-budget"),
          "pause",
          Date.now() + 30_000,
          "tokens",
          0,
          "at",
          Date.now(),
        );
        expect((await strict.client().get("/api/admin/stats", bearer())).statusCode).toBe(200);
        expect(
          (await strict.client({ ip: "192.0.2.1" }).get("/api/admin/stats", bearer())).statusCode,
        ).toBe(404);
      } finally {
        await strict.close();
      }
    });
    it("rejects a missing, wrong or malformed token with forbidden", async () => {
      const client = h.client();
      for (const headers of [
        {},
        bearer("wrong"),
        { authorization: "admin-token-for-tests" },
        { authorization: "Bearer " },
      ]) {
        for (const path of ["/api/admin/settings", "/api/admin/audit", "/api/admin/stats"]) {
          const response = await client.get(path, headers);
          expect(response.statusCode, `${path} ${JSON.stringify(headers)}`).toBe(403);
          expect(errorCode(response)).toBe("forbidden");
        }
      }
      expect((await client.put("/api/admin/settings", defaultSettings())).statusCode).toBe(403);
    });

    it("is switched off when ADMIN_TOKEN is empty", async () => {
      const off = await createHarness({ config: { adminToken: "" } });
      try {
        const response = await off.client().get("/api/admin/settings", bearer(""));
        expect(response.statusCode).toBe(404);
        expect(errorCode(response)).toBe("not_found");
      } finally {
        await off.close();
      }
    });

    it("counts token guesses against the login limit", async () => {
      const strict = await createHarness({
        config: {
          rateLimit: {
            apiPerMinute: 1000,
            codePerMinute: 100,
            createPerMinute: 100,
            loginPerMinute: 3,
          },
        },
      });
      try {
        const client = strict.client();
        for (let i = 0; i < 3; i++)
          expect((await client.get("/api/admin/stats", bearer("guess"))).statusCode).toBe(403);
        const blocked = await client.get("/api/admin/stats", bearer("guess"));
        expect(blocked.statusCode).toBe(429);
        expect(errorCode(blocked)).toBe("rate_limited");
        expect((await client.get("/api/admin/stats", bearer())).statusCode).toBe(200);
      } finally {
        await strict.close();
      }
    });
  });

  it("does not count requests with the right token against the login limit", async () => {
    const strict = await createHarness({
      config: {
        rateLimit: {
          apiPerMinute: 1000,
          codePerMinute: 100,
          createPerMinute: 100,
          loginPerMinute: 3,
        },
      },
    });
    try {
      const client = strict.client();
      for (let i = 0; i < 10; i++) {
        expect((await client.get("/api/admin/stats", bearer())).statusCode, `request ${i}`).toBe(
          200,
        );
      }
      // Legitimate parallel requests do not consume the guessed-token bucket.
      const parallel = await Promise.all(
        Array.from({ length: 3 }, () => client.get("/api/admin/settings", bearer())),
      );
      expect(parallel.map((r) => r.statusCode)).toEqual([200, 200, 200]);

      for (let i = 0; i < 3; i++)
        expect((await client.get("/api/admin/stats", bearer("guess"))).statusCode).toBe(403);
      // Guesses cannot lock out a legitimate administrator behind the same NAT.
      expect((await client.get("/api/admin/stats", bearer())).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });

  describe("settings", () => {
    it("returns the defaults first", async () => {
      const response = await h.client().get("/api/admin/settings", bearer());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(defaultSettings());
    });

    it("stores new settings and applies them at once", async () => {
      const client = h.client();
      const next = {
        ...defaultSettings(),
        anonymousTtlHours: 48,
        subnetPrefixV4: 16,
        contact: "help@gachipad.corp",
        rooms: [
          { name: "Room A", cidrs: [`${client.ip.split(".").slice(0, 2).join(".")}.0.0/16`] },
        ],
      };
      const put = await client.put("/api/admin/settings", next, bearer());
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual(next);
      expect(await h.stores.settings.get()).toEqual(next);
      expect((await client.get("/api/admin/settings", bearer())).json()).toEqual(next);

      // Rooms and TTL are in effect without a restart.
      expect((await client.get("/api/session")).json<{ room: string | null }>().room).toBe(
        "Room A",
      );
      const { id } = await createShare(client);
      const hours =
        (((await h.stores.shares.get(id))?.expiresAt?.getTime() ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(47.9);

      await client.put("/api/admin/settings", defaultSettings(), bearer());
    });

    it("rejects settings the API cannot act on", async () => {
      const client = h.client();
      const bad = [
        { ...defaultSettings(), rooms: [{ name: "X", cidrs: ["10.0.0.0/99"] }] },
        {
          ...defaultSettings(),
          rooms: [
            { name: "X", cidrs: [] },
            { name: "X", cidrs: [] },
          ],
        },
        { ...defaultSettings(), anonymousTtlHours: -1 },
        { ...defaultSettings(), auth: { oidc: { issuer: "not a url" }, ldap: null } },
        { ...defaultSettings(), auth: { oidc: null, ldap: { url: "http://wrong" } } },
        { anonymousTtlHours: "soon" },
      ];
      for (const body of bad) {
        const response = await client.put("/api/admin/settings", body, bearer());
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(errorCode(response)).toBe("validation");
      }
      expect(await h.stores.settings.get()).toEqual(defaultSettings());
    });

    it("normalises login provider blocks with their defaults", async () => {
      const client = h.client();
      const put = await client.put(
        "/api/admin/settings",
        {
          ...defaultSettings(),
          auth: {
            oidc: { issuer: "https://idp.corp", clientId: "gachipad", clientSecret: "s3cret" },
            ldap: { url: "ldaps://ad.corp", baseDn: "dc=corp,dc=local" },
          },
        },
        bearer(),
      );
      expect(put.statusCode).toBe(200);
      const stored = await h.stores.settings.get();
      expect(stored.auth.oidc).toMatchObject({
        scopes: "openid profile email",
        allowInsecure: false,
      });
      expect(stored.auth.ldap).toMatchObject({
        userFilter: "(uid={{username}})",
        nameAttribute: "cn",
        startTls: false,
      });
      await client.put("/api/admin/settings", defaultSettings(), bearer());
    });
  });

  describe("audit", () => {
    it("records no regular activity while auditing is off", async () => {
      const client = h.client();
      await createShare(client);
      expect(
        (await h.stores.audit.list({ limit: 10 })).filter(
          (entry) => entry.action !== "admin.login_failed",
        ),
      ).toEqual([]);
    });

    it("records who did what once enabled, newest first, and serves it to the admin", async () => {
      const admin = h.client();
      await admin.put(
        "/api/admin/settings",
        { ...defaultSettings(), audit: { enabled: true, retentionDays: 30 } },
        bearer(),
      );

      const user = h.client();
      const userId = await user.clientId();
      const { id } = await createShare(user, { title: "Audited" });
      await user.post(`/api/shares/${id}/join`);
      await h.client().get(`/api/shares/${id}/download`);
      await user.patch(`/api/shares/${id}`, { title: "Renamed" });
      await user.delete(`/api/shares/${id}`);

      const response = await admin.get("/api/admin/audit", bearer());
      expect(response.statusCode).toBe(200);
      const entries =
        response.json<
          {
            at: string;
            actor: string;
            ip: string;
            action: string;
            shareId?: string;
            detail?: unknown;
          }[]
        >();
      const actions = entries.filter((e) => e.shareId === id).map((e) => e.action);
      expect(actions).toEqual([
        "share.delete",
        "share.update",
        "share.download",
        "share.join",
        "share.create",
      ]);
      const created = entries.find((e) => e.action === "share.create");
      expect(created).toMatchObject({ actor: userId, ip: user.ip, shareId: id });
      expect(new Date(created?.at ?? "").toISOString()).toBe(created?.at);
      expect(entries.find((e) => e.action === "share.update")?.detail).toEqual({
        title: "Renamed",
      });
      expect(entries.some((e) => e.action === "admin.settings")).toBe(true);

      const limited = (await admin.get("/api/admin/audit?limit=2", bearer())).json<unknown[]>();
      expect(limited).toHaveLength(2);
      const before = entries[2]?.at as string;
      const older = (
        await admin.get(`/api/admin/audit?before=${encodeURIComponent(before)}`, bearer())
      ).json<{ at: string }[]>();
      expect(older.length).toBeGreaterThan(0);
      for (const entry of older)
        expect(new Date(entry.at).getTime()).toBeLessThan(new Date(before).getTime());
      expect((await admin.get("/api/admin/audit?limit=0", bearer())).statusCode).toBe(400);
      expect((await admin.get("/api/admin/audit?before=yesterday", bearer())).statusCode).toBe(400);
    });
  });

  describe("stats", () => {
    it("counts shares, labs, online users and upload bytes", async () => {
      const admin = h.client();
      interface Stats {
        shares: number;
        labs: number;
        onlineUsers: number;
        uploadBytes: number;
      }
      const read = async () => (await admin.get("/api/admin/stats", bearer())).json<Stats>();
      const before = await read();
      expect(Object.keys(before).sort()).toEqual(["labs", "onlineUsers", "shares", "uploadBytes"]);

      const owner = h.client();
      const { id } = await createShare(owner);
      await createShare(owner);
      await owner.post("/api/labs", {});
      await owner.multipart("/api/uploads", [{ name: "a.bin", data: new Uint8Array(1000) }]);
      await h.valkey.zadd("presence:all", Date.now(), "someone");
      await h.valkey.zadd("presence:all", Date.now() - 120_000, "long gone");

      const after = await read();
      expect(after.shares).toBe(before.shares + 2);
      expect(after.labs).toBe(before.labs + 1);
      expect(after.uploadBytes).toBe(before.uploadBytes + 1000);
      expect(after.onlineUsers).toBe(before.onlineUsers + 1);

      await owner.delete(`/api/shares/${id}`);
      expect((await read()).shares).toBe(before.shares + 1);
    });
  });
});
