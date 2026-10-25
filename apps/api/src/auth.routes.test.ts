import { defaultSettings } from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escapeLdapFilter,
  type LdapAdapter,
  type OidcAdapter,
  type VerifiedIdentity,
} from "./auth/adapters.js";
import { ldapAdapter } from "./auth/real.js";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe("LDAP helpers", () => {
  it("escapes every filter metacharacter (RFC 4515)", () => {
    expect(escapeLdapFilter("a*(b)\\c\u0000")).toBe("a\\2a\\28b\\29\\5cc\\00");
    expect(escapeLdapFilter("*)(uid=*))(|(uid=*")).not.toMatch(/[()*]/);
    expect(escapeLdapFilter("alice")).toBe("alice");
  });

  it("never binds with an empty password (that would be an anonymous bind)", async () => {
    const config = {
      url: "ldap://127.0.0.1:1",
      baseDn: "dc=x",
      userFilter: "(uid={{username}})",
      nameAttribute: "cn",
      startTls: false,
      tlsRejectUnauthorized: true,
    };
    expect(await ldapAdapter.authenticate(config, "alice", "")).toBeNull();
    expect(await ldapAdapter.authenticate(config, "", "pw")).toBeNull();
  });
});

describe.skipIf(!integration)("optional login", () => {
  const alice: VerifiedIdentity = {
    provider: "ldap",
    subject: "uid=alice,dc=corp",
    name: "Alice Kim",
    email: "alice@corp.local",
  };
  let ldapCalls: { config: unknown; username: string; password: string }[] = [];
  let ldapFails = false;
  const ldap: LdapAdapter = {
    async authenticate(config, username, password) {
      ldapCalls.push({ config, username, password });
      if (ldapFails) throw new Error("directory down");
      return username === "alice" && password === "right" ? alice : null;
    },
  };

  let authorizeCalls: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }[] = [];
  let exchangeCalls: {
    currentUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
  }[] = [];
  let exchangeFails = false;
  const oidc: OidcAdapter = {
    async authorizationUrl(_config, params) {
      authorizeCalls.push(params);
      return new URL(`https://idp.corp/authorize?state=${params.state}&nonce=${params.nonce}`);
    },
    async exchange(_config, params) {
      exchangeCalls.push(params);
      if (exchangeFails) throw new Error("bad code");
      return {
        provider: "oidc",
        subject: "sub-123",
        name: "Olivia Park",
        email: "olivia@corp.local",
      };
    },
  };

  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ ldap, oidc, config: { publicUrl: "https://gachipad.corp" } });
  });
  afterAll(() => h.close());

  const enable = async (patch: Partial<ReturnType<typeof defaultSettings>>) =>
    h.stores.settings.put({ ...defaultSettings(), ...patch });
  const ldapSettings = { url: "ldaps://ad.corp", baseDn: "dc=corp,dc=local" };
  const oidcSettings = { issuer: "https://idp.corp", clientId: "gachipad", clientSecret: "s3cret" };

  it("is off by default: providers say so and every login endpoint answers 404", async () => {
    await enable({});
    const client = h.client();
    expect((await client.get("/api/auth/providers")).json()).toEqual({
      oidc: false,
      ldap: false,
      guestAllowed: true,
    });
    const ldapLogin = await client.post("/api/auth/ldap/login", {
      username: "alice",
      password: "right",
    });
    expect(ldapLogin.statusCode).toBe(404);
    expect(errorCode(ldapLogin)).toBe("not_found");
    expect(ldapCalls).toHaveLength(0);
    expect((await client.get("/api/auth/oidc/login")).statusCode).toBe(404);
    expect((await client.get("/api/auth/oidc/callback?state=x")).statusCode).toBe(404);
    expect((await client.get("/api/session")).json<{ identity: unknown }>().identity).toBeNull();
  });

  it("lists the enabled providers", async () => {
    await enable({ auth: { oidc: oidcSettings, ldap: ldapSettings }, guestAllowed: false });
    expect((await h.client().get("/api/auth/providers")).json()).toEqual({
      oidc: true,
      ldap: true,
      guestAllowed: false,
    });
  });

  describe("LDAP", () => {
    it("binds a verified identity to the session and takes the name from the directory", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings } });
      ldapCalls = [];
      const client = h.client();
      const guestId = await client.clientId();
      const response = await client.post("/api/auth/ldap/login", {
        username: "alice",
        password: "right",
      });
      expect(response.statusCode).toBe(200);
      // The login starts a new session; the cookie now carries the id the identity is bound to.
      const { clientId } = response.json<{ clientId: string }>();
      expect(clientId).not.toBe(guestId);
      expect(await client.clientId()).toBe(clientId);
      expect(await h.valkey.exists(`identity:${guestId}`)).toBe(0);
      expect(response.json()).toMatchObject({
        name: "Alice Kim",
        identity: { provider: "ldap", name: "Alice Kim", email: "alice@corp.local" },
      });
      expect(ldapCalls).toHaveLength(1);
      expect(ldapCalls[0]).toMatchObject({
        username: "alice",
        password: "right",
        config: {
          url: "ldaps://ad.corp",
          baseDn: "dc=corp,dc=local",
          userFilter: "(uid={{username}})",
        },
      });
      expect(await h.valkey.hgetall(`identity:${clientId}`)).toEqual({
        provider: "ldap",
        subject: "uid=alice,dc=corp",
        name: "Alice Kim",
        email: "alice@corp.local",
      });
      expect((await client.get("/api/session")).json()).toMatchObject({
        name: "Alice Kim",
        identity: { provider: "ldap", email: "alice@corp.local" },
      });
    });

    it("starts a new session on login and on logout, so shares and history stay behind", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings } });
      const client = h.client();
      const first = await client.clientId();
      const { id } = await createShare(client, { title: "Before login" });
      expect((await client.get(`/api/shares/${id}`)).json<{ role: string }>().role).toBe("owner");

      await client.post("/api/auth/ldap/login", { username: "alice", password: "right" });
      const loggedIn = await client.clientId();
      expect(loggedIn).not.toBe(first);

      const logout = await client.post("/api/auth/logout");
      expect(logout.json()).toEqual({ ok: true });
      expect(logout.cookies.map((c) => c.name)).toContain("gachipad_sid");
      const next = await client.clientId();
      expect(next).not.toBe(loggedIn);
      expect(next).not.toBe(first);
      expect(await h.valkey.exists(`identity:${loggedIn}`)).toBe(0);
      // The next person on this browser owns nothing of the previous users.
      expect((await client.get("/api/session")).json<{ identity: unknown }>().identity).toBeNull();
      expect((await client.get("/api/shares")).json()).toEqual([]);
    });

    it("carries the chosen name over to the new session and leaves other profile data alone", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings } });
      const client = await h.client().named("Ally");
      const first = await client.clientId();
      await client.patch("/api/session", { color: "#102030" });
      await client.post("/api/auth/ldap/login", { username: "alice", password: "right" });
      expect(await client.clientId()).not.toBe(first);
      expect((await client.get("/api/session")).json()).toMatchObject({
        name: "Ally",
        color: "#102030",
      });
    });

    it("keeps a name the user already chose", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings } });
      const client = await h.client().named("Ally");
      await client.post("/api/auth/ldap/login", { username: "alice", password: "right" });
      expect((await client.get("/api/session")).json<{ name: string }>().name).toBe("Ally");
    });

    it("answers 403 for wrong credentials or an unreachable directory and binds nothing", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings } });
      const client = h.client();
      const clientId = await client.clientId();
      const wrong = await client.post("/api/auth/ldap/login", {
        username: "alice",
        password: "wrong",
      });
      expect(wrong.statusCode).toBe(403);
      expect(errorCode(wrong)).toBe("forbidden");
      ldapFails = true;
      const down = await client.post("/api/auth/ldap/login", {
        username: "alice",
        password: "right",
      });
      ldapFails = false;
      expect(down.statusCode).toBe(403);
      expect(await h.valkey.exists(`identity:${clientId}`)).toBe(0);
      expect((await client.post("/api/auth/ldap/login", { username: "alice" })).statusCode).toBe(
        400,
      );
    });

    it("limits login attempts per IP", async () => {
      const strict = await createHarness({
        ldap,
        config: {
          rateLimit: {
            apiPerMinute: 1000,
            codePerMinute: 100,
            createPerMinute: 100,
            loginPerMinute: 2,
          },
        },
      });
      try {
        await strict.stores.settings.put({
          ...defaultSettings(),
          auth: { oidc: null, ldap: ldapSettings },
        });
        const client = strict.client();
        for (let i = 0; i < 2; i++)
          expect(
            (await client.post("/api/auth/ldap/login", { username: "alice", password: "x" }))
              .statusCode,
          ).toBe(403);
        const blocked = await client.post("/api/auth/ldap/login", {
          username: "alice",
          password: "right",
        });
        expect(blocked.statusCode).toBe(429);
        expect(errorCode(blocked)).toBe("rate_limited");
      } finally {
        await strict.close();
      }
    });

    it("lets a logged-in user through when guests are not allowed, and logout closes the door again", async () => {
      await enable({ auth: { oidc: null, ldap: ldapSettings }, guestAllowed: false });
      const client = h.client();
      expect((await client.post("/api/shares")).statusCode).toBe(403);
      expect(
        (await client.post("/api/auth/ldap/login", { username: "alice", password: "right" }))
          .statusCode,
      ).toBe(200);
      expect((await client.post("/api/shares")).statusCode).toBe(200);
      expect((await client.post("/api/auth/logout")).json()).toEqual({ ok: true });
      expect((await client.get("/api/session")).json<{ identity: unknown }>().identity).toBeNull();
      expect((await client.post("/api/shares")).statusCode).toBe(403);
    });
  });

  describe("OIDC", () => {
    const start = async (client: ReturnType<Harness["client"]>) => {
      const response = await client.get("/api/auth/oidc/login");
      const state = new URL(response.headers.location as string).searchParams.get(
        "state",
      ) as string;
      return { response, state };
    };

    it("redirects to the provider and keeps nonce, PKCE verifier and the browser's id for 10 minutes", async () => {
      await enable({ auth: { oidc: oidcSettings, ldap: null } });
      authorizeCalls = [];
      const client = h.client();
      const clientId = await client.clientId();
      const { response, state } = await start(client);
      expect(response.statusCode).toBe(302);
      expect(String(response.headers.location)).toMatch(/^https:\/\/idp\.corp\/authorize\?state=/);
      expect(authorizeCalls).toHaveLength(1);
      expect(authorizeCalls[0]?.redirectUri).toBe("https://gachipad.corp/api/auth/oidc/callback");
      const stored = JSON.parse((await h.valkey.get(`oidc:state:${state}`)) as string);
      expect(stored).toEqual({
        clientId,
        nonce: authorizeCalls[0]?.nonce,
        codeVerifier: authorizeCalls[0]?.codeVerifier,
      });
      expect(await h.valkey.ttl(`oidc:state:${state}`)).toBeGreaterThan(0);
      expect(await h.valkey.ttl(`oidc:state:${state}`)).toBeLessThanOrEqual(600);
      expect(state.length).toBeGreaterThanOrEqual(32);
    });

    it("completes the login on the callback, once", async () => {
      await enable({ auth: { oidc: oidcSettings, ldap: null } });
      exchangeCalls = [];
      const client = h.client();
      const guestId = await client.clientId();
      const { state } = await start(client);
      const callback = await client.get(
        `/api/auth/oidc/callback?state=${state}&code=abc&iss=https%3A%2F%2Fidp.corp`,
      );
      expect(callback.statusCode).toBe(302);
      const clientId = await client.clientId();
      expect(clientId).not.toBe(guestId);
      expect(callback.headers.location).toBe("https://gachipad.corp/");
      expect(exchangeCalls).toHaveLength(1);
      const call = exchangeCalls[0] as (typeof exchangeCalls)[number];
      expect(call.state).toBe(state);
      expect(call.nonce).toBe(authorizeCalls.at(-1)?.nonce);
      expect(call.codeVerifier).toBe(authorizeCalls.at(-1)?.codeVerifier);
      expect(call.currentUrl.origin + call.currentUrl.pathname).toBe(
        "https://gachipad.corp/api/auth/oidc/callback",
      );
      expect(call.currentUrl.searchParams.get("code")).toBe("abc");
      expect(await h.valkey.hgetall(`identity:${clientId}`)).toMatchObject({
        provider: "oidc",
        subject: "sub-123",
        name: "Olivia Park",
      });
      expect((await client.get("/api/session")).json()).toMatchObject({
        name: "Olivia Park",
        identity: { provider: "oidc", email: "olivia@corp.local" },
      });

      const replay = await client.get(`/api/auth/oidc/callback?state=${state}&code=abc`);
      expect(replay.statusCode).toBe(403);
      expect(errorCode(replay)).toBe("forbidden");
    });

    it("refuses an unknown state and a state started by another browser", async () => {
      await enable({ auth: { oidc: oidcSettings, ldap: null } });
      exchangeCalls = [];
      const victim = h.client();
      const attacker = h.client();
      const { state } = await start(victim);
      expect(
        (await attacker.get(`/api/auth/oidc/callback?state=${state}&code=abc`)).statusCode,
      ).toBe(403);
      expect(
        (await attacker.get("/api/auth/oidc/callback?state=made-up&code=abc")).statusCode,
      ).toBe(403);
      expect((await attacker.get("/api/auth/oidc/callback?code=abc")).statusCode).toBe(400);
      expect(exchangeCalls).toHaveLength(0);
      expect(await h.valkey.exists(`identity:${await attacker.clientId()}`)).toBe(0);
    });

    it("answers 403 when the provider rejects the code, and the state is spent", async () => {
      await enable({ auth: { oidc: oidcSettings, ldap: null } });
      const client = h.client();
      const { state } = await start(client);
      exchangeFails = true;
      const failed = await client.get(`/api/auth/oidc/callback?state=${state}&code=bad`);
      exchangeFails = false;
      expect(failed.statusCode).toBe(403);
      expect(errorCode(failed)).toBe("forbidden");
      expect(await h.valkey.exists(`oidc:state:${state}`)).toBe(0);
      expect(await h.valkey.exists(`identity:${await client.clientId()}`)).toBe(0);
    });

    it("needs a redirect URI: PUBLIC_URL or the provider setting", async () => {
      const bare = await createHarness({ oidc });
      try {
        await bare.stores.settings.put({
          ...defaultSettings(),
          auth: { oidc: oidcSettings, ldap: null },
        });
        const missing = await bare.client().get("/api/auth/oidc/login");
        expect(missing.statusCode).toBe(400);
        await bare.stores.settings.put({
          ...defaultSettings(),
          auth: { oidc: { ...oidcSettings, redirectUri: "https://gachipad.corp/cb" }, ldap: null },
        });
        authorizeCalls = [];
        expect((await bare.client().get("/api/auth/oidc/login")).statusCode).toBe(302);
        expect(authorizeCalls[0]?.redirectUri).toBe("https://gachipad.corp/cb");
      } finally {
        await bare.close();
      }
    });
  });
});
