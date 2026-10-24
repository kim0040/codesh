import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdminUpdateResponse, apiKeys, settingsSchema } from "@codesh/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UpdateConfig } from "./config.js";
import { createHarness, eventually, type Harness, integration } from "./testing/harness.js";
import { DEFAULT_UPDATE_TIMERS, UpdateChecker } from "./updates.js";

const bearer = { authorization: "Bearer admin-token-for-tests" };

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/** Stands in for api.github.com: records every request and answers with `handler`. */
async function fakeGitHub() {
  const seen: Seen[] = [];
  let handler: (request: Seen, response: ServerResponse) => void = (_request, response) =>
    response.writeHead(404).end();
  const server = createServer((request, response) => {
    const entry = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
    };
    seen.push(entry);
    handler(entry, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    answer(next: typeof handler) {
      handler = next;
    },
    json(status: number, body: unknown, headers: Record<string, string> = {}) {
      handler = (_request, response) =>
        response
          .writeHead(status, { "content-type": "application/json", ...headers })
          .end(JSON.stringify(body));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/kim0040/codesh/releases/tag/${tag}`,
  published_at: "2026-10-20T09:30:00Z",
  body: `## ${tag}\r\n\r\n- Fixed <b>things</b>`,
  draft: false,
  prerelease: false,
  ...extra,
});

describe.skipIf(!integration)("update check", () => {
  let github: Awaited<ReturnType<typeof fakeGitHub>>;
  let h: Harness;
  const settings = (overrides: Partial<UpdateConfig> = {}): UpdateConfig => ({
    enabled: true,
    repo: "kim0040/codesh",
    channel: "stable",
    apiUrl: github.url,
    statusFile: "",
    ...overrides,
  });
  const harness = (overrides: Partial<UpdateConfig> = {}, version = "1.0.0") =>
    createHarness({ version, config: { update: settings(overrides) } });
  /** "Check now" with the token, the cooldown cleared first so one test can ask several times. */
  const checkNow = async (target: Harness) => {
    await target.valkey.del(apiKeys.updateManual);
    return target.client().request("POST", "/api/admin/update/check", { headers: bearer });
  };

  beforeAll(async () => {
    github = await fakeGitHub();
  });
  afterAll(() => github.close());
  afterEach(async () => {
    await h?.close();
    github.seen.length = 0;
  });

  it("finds a newer release with one plain GET that carries nothing but the version", async () => {
    h = await harness();
    github.json(200, release("v1.2.0"), { etag: '"e1"' });
    const admin = h.client();
    const response = await admin.request("POST", "/api/admin/update/check", { headers: bearer });
    expect(response.statusCode).toBe(200);
    const body = response.json<AdminUpdateResponse>();
    expect(body).toMatchObject({
      current: "1.0.0",
      latest: "1.2.0",
      status: "ok",
      updateAvailable: true,
      url: "https://github.com/kim0040/codesh/releases/tag/v1.2.0",
      publishedAt: "2026-10-20T09:30:00.000Z",
      notes: "## v1.2.0\n\n- Fixed <b>things</b>",
      repo: "kim0040/codesh",
      channel: "stable",
      releasesUrl: "https://github.com/kim0040/codesh/releases",
      updater: null,
    });
    expect(github.seen).toHaveLength(1);
    const [request] = github.seen as [Seen];
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/repos/kim0040/codesh/releases/latest");
    expect(request.headers["user-agent"]).toBe("codesh/1.0.0");
    for (const name of ["authorization", "cookie", "x-forwarded-for", "referer", "if-none-match"])
      expect(request.headers[name], name).toBeUndefined();

    // The admin GET reads the cached state and asks no one.
    const cached = await admin.get("/api/admin/update", bearer);
    expect(cached.json<AdminUpdateResponse>().latest).toBe("1.2.0");
    expect(github.seen).toHaveLength(1);
  });

  it("reports no update for the same version and a 404 (no release yet) as ok", async () => {
    h = await harness();
    github.json(200, release("v1.0.0"));
    const same = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(same).toMatchObject({ latest: "1.0.0", status: "ok", updateAvailable: false });

    github.json(404, { message: "Not Found" });
    const none = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(none).toMatchObject({ latest: null, url: null, status: "ok", updateAvailable: false });
  });

  it("ignores pre-releases and drafts on stable and offers pre-releases on the prerelease channel", async () => {
    h = await harness();
    github.json(200, release("v1.1.0-rc.1", { prerelease: true }));
    expect((await checkNow(h)).json<AdminUpdateResponse>()).toMatchObject({
      latest: null,
      updateAvailable: false,
    });
    await h.close();

    h = await harness({ channel: "prerelease" });
    github.seen.length = 0;
    github.json(200, [
      release("v2.0.0", { draft: true }),
      release("v1.1.0-rc.1", { prerelease: true }),
      release("v1.0.1"),
      release("not-a-version"),
    ]);
    const pre = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(pre).toMatchObject({
      latest: "1.1.0-rc.1",
      channel: "prerelease",
      updateAvailable: true,
    });
    expect(github.seen[0]?.url).toBe("/repos/kim0040/codesh/releases?per_page=20");
  });

  it("sends the ETag back and keeps the release on 304 Not Modified", async () => {
    h = await harness();
    github.json(200, release("v1.2.0"), { etag: 'W/"abc"' });
    const first = (await checkNow(h)).json<AdminUpdateResponse>();
    github.answer((_request, response) => response.writeHead(304).end());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(github.seen[1]?.headers["if-none-match"]).toBe('W/"abc"');
    expect(second).toMatchObject({ latest: "1.2.0", status: "ok", updateAvailable: true });
    expect(Date.parse(second.checkedAt ?? "")).toBeGreaterThan(Date.parse(first.checkedAt ?? ""));
  });

  it("backs off until the rate limit resets and keeps what it knew", async () => {
    h = await harness();
    github.json(200, release("v1.2.0"));
    await checkNow(h);
    const reset = Math.floor(Date.now() / 1000) + 600;
    github.json(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    );
    const limited = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(limited).toMatchObject({
      status: "unreachable",
      latest: "1.2.0",
      updateAvailable: true,
    });
    expect(github.seen).toHaveLength(2);
    // Until the reset nobody asks again, not even "check now".
    await checkNow(h);
    expect(github.seen).toHaveLength(2);
    const stored = JSON.parse((await h.valkey.get(apiKeys.updateState)) ?? "{}") as {
      retryAt: number;
    };
    expect(stored.retryAt).toBe(reset * 1000);
  });

  it("fails fast and quietly when offline or when GitHub does not answer", async () => {
    h = await harness({ apiUrl: "http://127.0.0.1:9" });
    const started = Date.now();
    const offline = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(offline).toMatchObject({ status: "unreachable", latest: null, updateAvailable: false });
    expect(Date.now() - started).toBeLessThan(2000);
    await h.close();

    // A server that accepts and never answers: the timeout ends it.
    github.answer(() => undefined);
    h = await createHarness({
      version: "1.0.0",
      config: { update: settings() },
      updateTimers: { ...DEFAULT_UPDATE_TIMERS, timeoutMs: 300 },
    });
    const slow = Date.now();
    const hung = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(hung.status).toBe("unreachable");
    expect(Date.now() - slow).toBeLessThan(2000);
  });

  it("makes no request at all with UPDATE_CHECK=off", async () => {
    h = await createHarness({
      version: "1.0.0",
      config: { update: settings({ enabled: false }) },
      updateTimers: {
        ...DEFAULT_UPDATE_TIMERS,
        firstDelayMs: 0,
        firstJitterMs: 0,
        intervalMs: 60_000,
      },
    });
    github.json(200, release("v9.0.0"));
    const state = (await h.client().get("/api/admin/update", bearer)).json<AdminUpdateResponse>();
    expect(state).toMatchObject({ status: "disabled", latest: null, updateAvailable: false });
    const checked = await h
      .client()
      .request("POST", "/api/admin/update/check", { headers: bearer });
    expect(checked.json<AdminUpdateResponse>().status).toBe("disabled");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(github.seen).toHaveLength(0);
  });

  it("runs the scheduled check once per deployment, however many instances start", async () => {
    h = await harness();
    github.json(200, release("v1.1.0"));
    const timers = { ...DEFAULT_UPDATE_TIMERS, firstDelayMs: 0, firstJitterMs: 50 };
    const instances = Array.from(
      { length: 3 },
      () => new UpdateChecker(settings(), h.valkey, "1.0.0", timers),
    );
    for (const instance of instances) instance.start();
    try {
      await eventually(async () => (await instances[0]?.state())?.status === "ok");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(github.seen).toHaveLength(1);
      // The status check of the console reads only Valkey.
      expect((await instances[2]?.state())?.latest).toBe("1.1.0");
    } finally {
      for (const instance of instances) instance.stop();
    }
  });

  it("limits check now to once a minute for the whole deployment", async () => {
    h = await harness();
    github.json(200, release("v1.1.0"));
    const first = await h.client().request("POST", "/api/admin/update/check", { headers: bearer });
    expect(first.statusCode).toBe(200);
    const second = await h.client().request("POST", "/api/admin/update/check", { headers: bearer });
    expect(second.statusCode).toBe(429);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect(github.seen).toHaveLength(1);
  });

  it("keeps the update state for admins: forbidden without the token", async () => {
    h = await harness();
    for (const [method, path] of [
      ["GET", "/api/admin/update"],
      ["POST", "/api/admin/update/check"],
    ] as const) {
      const response = await h.client().request(method, path, { body: {} });
      expect(response.statusCode, path).toBe(403);
    }
    expect(github.seen).toHaveLength(0);
  });

  it("drops a release link that is not a web address", async () => {
    h = await harness({ apiUrl: github.url });
    github.json(200, release("v1.3.0", { html_url: "javascript:alert(1)" }));
    const body = (await checkNow(h)).json<AdminUpdateResponse>();
    expect(body).toMatchObject({ latest: "1.3.0", url: null });
  });

  it("shows the updater's status file when it is mounted, and nothing for a broken one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codesh-update-"));
    try {
      const file = join(dir, "update.json");
      await writeFile(
        file,
        JSON.stringify({
          auto: { enabled: true, at: "04:00", policy: "patch" },
          lastRun: {
            at: "2026-10-21T04:02:00Z",
            result: "updated",
            from: "1.0.0",
            to: "1.0.1",
            message: null,
          },
        }),
      );
      h = await harness({ statusFile: file });
      const body = (await h.client().get("/api/admin/update", bearer)).json<AdminUpdateResponse>();
      expect(body.updater).toEqual({
        auto: { enabled: true, at: "04:00", policy: "patch" },
        lastRun: {
          at: "2026-10-21T04:02:00Z",
          result: "updated",
          from: "1.0.0",
          to: "1.0.1",
          message: null,
        },
      });
      await writeFile(file, "{not json");
      expect(
        (await h.client().get("/api/admin/update", bearer)).json<AdminUpdateResponse>().updater,
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves the version publicly, even when guests are not allowed", async () => {
    h = await harness({}, "1.4.2");
    await h.stores.settings.put(
      settingsSchema.parse({ ...(await h.stores.settings.get()), guestAllowed: false }),
    );
    const response = await h.client().get("/api/version");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "1.4.2" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((await h.client().get("/readyz")).json()).toEqual({ ok: true });
    expect(github.seen).toHaveLength(0);
  });
});
