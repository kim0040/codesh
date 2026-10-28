import {
  type DiagnosticEvent,
  defaultSettings,
  type ServerDiagnosticBundle,
} from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const bearer = { authorization: "Bearer admin-token-for-tests" };
const endpoints = [
  ["GET", "/api/admin/overview"],
  ["GET", "/api/admin/diagnostics"],
  ["GET", "/api/admin/diagnostics/export"],
  ["GET", "/api/admin/security"],
  ["GET", "/api/admin/shares"],
  ["POST", "/api/admin/shares/Abcd1234/lock"],
  ["POST", "/api/admin/shares/Abcd1234/unlock"],
  ["POST", "/api/admin/shares/Abcd1234/delete"],
] as const;
describe.skipIf(!integration)("admin operational API", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  it.each(endpoints)("%s %s requires auth and is never cached", async (method, path) => {
    const result = await h.client().request(method, path);
    expect(result.statusCode).toBe(403);
    expect(result.headers["cache-control"]).toContain("no-store");
  });
  it("returns 404 before validation, rate limits, session allocation or storage when off or CIDR-denied", async () => {
    for (const config of [{ adminToken: "" }, { adminAllowCidr: ["192.0.2.0/24"] }]) {
      const app = await createHarness({ config });
      const read = vi.spyOn(app.stores.settings, "get");
      try {
        for (const [method, path] of endpoints) {
          const response = await app
            .client()
            .request(method, `${path}?since=bad`, { headers: bearer });
          expect(response.statusCode, `${method} ${path}`).toBe(404);
          expect(response.headers["set-cookie"]).toBeUndefined();
        }
        expect(read).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it("checks CIDR against trusted client IP and ignores spoofed forwarding from an untrusted peer", async () => {
    const deny = await createHarness({
      config: { trustProxy: [], adminAllowCidr: ["10.0.0.0/8"] },
    });
    try {
      expect(
        (
          await deny.app.inject({
            method: "GET",
            url: "/api/admin/security",
            remoteAddress: "198.51.100.8",
            headers: { ...bearer, "x-forwarded-for": "10.1.2.3" },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await deny.close();
    }
    const allow = await createHarness({
      config: { trustProxy: ["127.0.0.1/32"], adminAllowCidr: ["10.0.0.0/8"] },
    });
    try {
      expect(
        (await allow.client({ ip: "10.1.2.3" }).get("/api/admin/security", bearer)).statusCode,
      ).toBe(200);
      expect(
        (await allow.client({ ip: "10.1.2.3, 198.51.100.8" }).get("/api/admin/security", bearer))
          .statusCode,
      ).toBe(404);
    } finally {
      await allow.close();
    }
  });
  it("captures 5xx route, code and safe source frames without error payload values", async () => {
    const failure = new Error("SECRET_DOCUMENT_AND_TOKEN");
    failure.stack =
      "Error: SECRET_DOCUMENT_AND_TOKEN\n at boom (file:///private/src/routes/admin-diagnostics.ts:1:2)";
    vi.spyOn(h.stores.shares, "adminSummary").mockRejectedValueOnce(failure);
    const response = await h.client().get("/api/admin/overview", bearer);
    expect(response.statusCode).toBe(500);
    const events = (await h.client().get("/api/admin/diagnostics?level=error", bearer)).json<
      DiagnosticEvent[]
    >();
    expect(
      events.some(
        (e) =>
          e.kind === "response_5xx" &&
          e.details.route === "/api/admin/overview" &&
          e.details.status === 500 &&
          e.details.code === "unknown",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.kind === "server_error" &&
          e.details.stack?.includes("/src/routes/admin-diagnostics.ts:1:2"),
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET_DOCUMENT_AND_TOKEN");
  });
  it("keeps diagnostics/security/export usable when Mongo, profile storage or Valkey health fails", async () => {
    const offline = await createHarness();
    try {
      vi.spyOn(offline.stores.settings, "get").mockRejectedValue(new Error("PRIVATE_DB_FAILURE"));
      vi.spyOn(offline.stores.diagnostics, "list").mockRejectedValue(
        new Error("PRIVATE_DB_FAILURE"),
      );
      vi.spyOn(offline.valkey, "ping").mockRejectedValue(new Error("PRIVATE_VALKEY_FAILURE"));
      for (const path of [
        "/api/admin/security",
        "/api/admin/diagnostics",
        "/api/admin/diagnostics/export",
      ]) {
        const response = await offline.client().get(path, bearer);
        expect(response.statusCode, path).toBe(200);
        expect(response.body).not.toMatch(/PRIVATE_DB_FAILURE|PRIVATE_VALKEY_FAILURE/);
        if (path.endsWith("export"))
          expect(response.json<ServerDiagnosticBundle>()).toMatchObject({
            health: { mongo: false, valkey: false, collab: "unknown" },
            config: { OIDC_CLIENT_SECRET_SET: "unknown" },
          });
      }
    } finally {
      await offline.close();
    }
  });
  it("filters redacted events and exports only allowlisted configuration", async () => {
    const client = h.client();
    await client.get("/api/admin/security", { authorization: "Bearer PRIVATE_TOKEN" });
    const response = await client.get("/api/admin/diagnostics?level=warn&source=api", bearer);
    expect(response.statusCode).toBe(200);
    const events = response.json<DiagnosticEvent[]>();
    expect(events.some((e) => e.kind === "admin_login_failed")).toBe(true);
    expect((await client.get("/api/admin/diagnostics?since=invalid", bearer)).statusCode).toBe(400);
    const exported = await client.get("/api/admin/diagnostics/export", bearer);
    expect(exported.headers["content-disposition"]).toMatch(
      /^attachment; filename="gachipad-server-diagnostics-[\w.-]+\.json"$/,
    );
    const bundle = exported.json<ServerDiagnosticBundle>();
    expect(bundle.header).toContain("gachipad server diagnostics");
    expect(bundle).toMatchObject({
      format: 1,
      config: { ADMIN_TOKEN_SET: true, storage: "memory", DATABASE_URL_SET: false },
      caps: { events: 500, bytes: 262144, days: 14 },
    });
    expect(JSON.stringify(bundle)).not.toMatch(
      /PRIVATE_TOKEN|admin-token-for-tests|dev-only-secret|mongodb:|redis:/,
    );
    const security = (await client.get("/api/admin/security", bearer)).json<{
      failedLogins: DiagnosticEvent[];
    }>();
    expect(security.failedLogins.length).toBeGreaterThan(0);
    const audit = (await client.get("/api/admin/audit", bearer)).json<
      { action: string; ip: string }[]
    >();
    expect(audit.some((a) => a.action === "admin.login_failed" && a.ip.startsWith("hash:"))).toBe(
      true,
    );
  });
  it("reports the selected backend and URL presence without exporting the URL", async () => {
    const selected = await createHarness({
      config: {
        storage: "postgresql",
        databaseUrl: "postgresql://ops:private-value@db.example/test",
        databaseUrlSet: true,
      },
    });
    try {
      const exported = await selected.client().get("/api/admin/diagnostics/export", bearer);
      expect(exported.statusCode).toBe(200);
      const bundle = exported.json<ServerDiagnosticBundle>();
      expect(bundle.config).toMatchObject({ storage: "postgresql", DATABASE_URL_SET: true });
      expect(JSON.stringify(bundle)).not.toMatch(/private-value|postgresql:\/\//);
    } finally {
      await selected.close();
    }
  });
  it("limits audit samples and preserves legitimate access after parallel guesses", async () => {
    const strict = await createHarness({
      config: {
        rateLimit: { apiPerMinute: 1, codePerMinute: 1, createPerMinute: 1, loginPerMinute: 2 },
      },
    });
    try {
      const client = strict.client();
      const append = vi.spyOn(strict.stores.audit, "append");
      const guesses = await Promise.all(
        Array.from({ length: 20 }, () =>
          client.get("/api/admin/security", { authorization: "Bearer WRONG" }),
        ),
      );
      expect(guesses.some((r) => r.statusCode === 429)).toBe(true);
      expect(append).toHaveBeenCalledTimes(1);
      expect((await client.get("/api/admin/security", bearer)).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });
  it("keeps encoded, absolute-form and HEAD admin requests behind authentication", async () => {
    for (const url of [
      "/api/%61dmin/security",
      "/api%2fadmin/security",
      "http://localhost/api/admin/security",
      "/api//admin/security",
    ]) {
      const result = await h.app.inject({ method: "GET", url });
      expect(result.statusCode, url).not.toBe(200);
    }
    expect((await h.app.inject({ method: "HEAD", url: "/api/admin/security" })).statusCode).toBe(
      403,
    );
  });
  it("does not accept credentials in query strings or enable CORS", async () => {
    const client = h.client();
    const response = await client.get("/api/admin/security?token=admin-token-for-tests");
    expect(response.statusCode).toBe(403);
    const preflight = await h.app.inject({
      method: "OPTIONS",
      url: "/api/admin/settings",
      headers: {
        origin: "https://attacker.test",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const mutation = await h.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { origin: "https://attacker.test", "content-type": "application/json" },
      payload: defaultSettings(),
    });
    expect(mutation.statusCode).toBe(403);
  });
  it("returns metadata only, supports lock/unlock, and only deletes through delete", async () => {
    const owner = h.client();
    const { id } = await createShare(owner, {
      title: "ops needle",
      files: [{ path: "sensitive-file.ts", content: "DO_NOT_RETURN_DOCUMENT" }],
    });
    const listed = await owner.get("/api/admin/shares?search=needle", bearer);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ id: string }[]>().some((s) => s.id === id)).toBe(true);
    expect(listed.body).not.toMatch(
      /DO_NOT_RETURN_DOCUMENT|sensitive-file|editKey|pinHash|preview|ownerId/,
    );
    const locked = await owner.request("POST", `/api/admin/shares/${id}/lock`, { headers: bearer });
    expect(locked.statusCode).toBe(200);
    expect((await h.stores.shares.get(id))?.locked).toBe(true);
    const overview = await owner.get("/api/admin/overview", bearer);
    expect(overview.statusCode).toBe(200);
    expect(overview.json<{ activity: number[] }>().activity).toHaveLength(24);
    const expired = await owner.request("POST", `/api/admin/shares/${id}/expire`, {
      headers: bearer,
    });
    expect(expired.statusCode).toBe(404);
    expect((await h.stores.shares.get(id))?.locked).toBe(true);
    const unlocked = await owner.request("POST", `/api/admin/shares/${id}/unlock`, {
      headers: bearer,
    });
    expect(unlocked.statusCode).toBe(200);
    expect((await h.stores.shares.get(id))?.locked).toBe(false);
    const deleted = await owner.request("POST", `/api/admin/shares/${id}/delete`, {
      headers: bearer,
    });
    expect(deleted.statusCode).toBe(200);
    expect((await owner.get(`/api/shares/${id}`)).statusCode).toBe(404);
    expect(await h.stores.shares.touch(id, new Date(), new Date(Date.now() + 86400000))).toBe(
      false,
    );
    expect(await h.stores.shares.get(id)).toBeNull();
    expect(
      (await owner.request("POST", `/api/admin/shares/${id}/lock`, { headers: bearer })).statusCode,
    ).toBe(404);
  });
});
