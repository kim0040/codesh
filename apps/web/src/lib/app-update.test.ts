import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { RegisterSWOptions } from "virtual:pwa-register";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn<(options?: RegisterSWOptions) => (reload?: boolean) => Promise<void>>(),
  flush: vi.fn(async () => true),
}));
vi.mock("virtual:pwa-register", () => ({ registerSW: mocks.register }));
vi.mock("./collab/session", () => ({ flushPendingSessions: mocks.flush }));

const answer = (version: string) =>
  vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 }));

describe("app update", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.flush.mockReset().mockResolvedValue(true);
    mocks.register.mockReset().mockReturnValue(async () => undefined);
    vi.stubEnv("VITE_APP_VERSION", "1.0.0");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("offers a reload only when the server runs another version", async () => {
    const update = await import("./app-update");
    const same = answer("1.0.0");
    vi.stubGlobal("fetch", same);
    await update.checkServerVersion(0);
    expect(same).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(update.appUpdateState().available).toBe(false);

    vi.stubGlobal("fetch", answer("1.1.0"));
    await update.checkServerVersion(0);
    expect(update.appUpdateState()).toMatchObject({ available: true, serverVersion: "1.1.0" });
  });

  it("stays quiet when offline and asks again on the next trigger", async () => {
    const update = await import("./app-update");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await expect(update.checkServerVersion(0)).resolves.toBeUndefined();
    expect(update.appUpdateState().available).toBe(false);
  });

  it("asks at most once per gap; a collab reconnect uses a short gap", async () => {
    const update = await import("./app-update");
    const fetch = answer("1.0.0");
    vi.stubGlobal("fetch", fetch);
    await update.checkServerVersion(0);
    await update.checkServerVersion();
    update.onCollabConnected();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("hides the prompt on Later until yet another version shows up", async () => {
    const update = await import("./app-update");
    vi.stubGlobal("fetch", answer("1.1.0"));
    await update.checkServerVersion(0);
    update.dismissAppUpdate();
    expect(update.appUpdateState()).toMatchObject({ available: true, dismissed: true });
    vi.stubGlobal("fetch", answer("1.1.0"));
    await update.checkServerVersion(0);
    expect(update.appUpdateState().dismissed).toBe(true);
    vi.stubGlobal("fetch", answer("1.2.0"));
    await update.checkServerVersion(0);
    expect(update.appUpdateState()).toMatchObject({ serverVersion: "1.2.0", dismissed: false });
  });

  it("uses the installed Workbox registration in two tabs: only the approving tab reloads", async () => {
    // Exercise the library's real controlling handlers, rather than mocking registerSW's behavior.
    const require = createRequire(import.meta.url);
    const source = readFileSync(
      join(dirname(require.resolve("vite-plugin-pwa")), "client/build/register.js"),
      "utf8",
    )
      .replace('import("workbox-window")', "loadWorkbox()")
      .replace(/export \{[\s\S]*$/, "return registerSW;");
    type Handler = (event: { isUpdate: boolean }) => void;
    const tabs: Array<{
      handlers: Map<string, Handler[]>;
      reload: ReturnType<typeof vi.fn>;
      window: {
        location: { reload: ReturnType<typeof vi.fn> };
        setInterval: typeof vi.fn;
        addEventListener: typeof vi.fn;
      };
      registration: { waiting: object | null; update: ReturnType<typeof vi.fn> };
      update: typeof import("./app-update");
    }> = [];
    const skipWaiting = vi.fn();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });
    vi.stubGlobal("fetch", answer("1.1.0"));
    for (let i = 0; i < 2; i++) {
      vi.resetModules();
      const handlers = new Map<string, Handler[]>();
      const reload = vi.fn();
      const window = { location: { reload }, setInterval: vi.fn(), addEventListener: vi.fn() };
      const registration = { waiting: {}, update: vi.fn(async () => undefined) };
      class Workbox {
        addEventListener(name: string, handler: Handler) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        }
        register() {
          return Promise.resolve(registration);
        }
        messageSkipWaiting() {
          skipWaiting();
        }
      }
      const register = new Function("navigator", "window", "loadWorkbox", source)(
        { serviceWorker: {} },
        window,
        async () => ({ Workbox }),
      ) as (options?: RegisterSWOptions) => (reload?: boolean) => Promise<void>;
      mocks.register.mockImplementation(register);
      vi.stubGlobal("navigator", { serviceWorker: {} });
      vi.stubGlobal("window", window);
      const update = await import("./app-update");
      update.startAppUpdates();
      await vi.waitFor(() => expect(handlers.has("waiting")).toBe(true));
      for (const handler of handlers.get("waiting") ?? []) handler({ isUpdate: true });
      tabs.push({ handlers, reload, window, registration, update });
    }
    const [clicked, later] = tabs;
    if (!clicked || !later) throw new Error("missing tabs");
    later.update.dismissAppUpdate();
    vi.stubGlobal("window", clicked.window);
    expect(await clicked.update.applyAppUpdate()).toBe(true);
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    // The SW emits controlling in BOTH contexts, exactly as Workbox does across browser tabs.
    for (const tab of tabs) {
      vi.stubGlobal("window", tab.window);
      tab.registration.waiting = null;
      for (const handler of tab.handlers.get("controlling") ?? []) handler({ isUpdate: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(clicked.reload).toHaveBeenCalledTimes(1);
    expect(later.reload).not.toHaveBeenCalled();
    expect(later.update.appUpdateState().dismissed).toBe(false);
    vi.stubGlobal("window", later.window);
    await later.update.applyAppUpdate();
    expect(later.reload).toHaveBeenCalledTimes(1);
  });

  it("checks pending edits again when the new worker takes control", async () => {
    const reload = vi.fn();
    const registration = { waiting: {} as object | null, update: vi.fn(async () => undefined) };
    mocks.register.mockImplementation((options) => {
      options?.onRegisteredSW?.("sw.js", registration as unknown as ServiceWorkerRegistration);
      return async () => undefined;
    });
    vi.stubEnv("PROD", true);
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", {
      location: { reload },
      setInterval: vi.fn(),
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("fetch", answer("1.1.0"));
    const update = await import("./app-update");
    update.startAppUpdates();
    expect(await update.applyAppUpdate()).toBe(true);
    mocks.flush.mockResolvedValue(false);
    mocks.register.mock.calls[0]?.[0]?.onNeedReload?.();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    // A later controlling event cannot revive the failed approval.
    mocks.flush.mockResolvedValue(true);
    mocks.register.mock.calls[0]?.[0]?.onNeedReload?.();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    registration.waiting = null;
    await update.applyAppUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps unsent edits alive when the server cannot acknowledge them", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    mocks.flush.mockResolvedValue(false);
    const update = await import("./app-update");
    expect(await update.applyAppUpdate()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    mocks.flush.mockResolvedValue(true);
    expect(await update.applyAppUpdate()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("expires tab approval and re-shows a dismissed prompt after a stale chunk fails", async () => {
    const reload = vi.fn();
    const addEventListener = vi.fn();
    const registration = { waiting: {}, update: vi.fn(async () => undefined) };
    mocks.register.mockImplementation((options) => {
      options?.onRegisteredSW?.("sw.js", registration as unknown as ServiceWorkerRegistration);
      return async () => undefined;
    });
    vi.stubEnv("PROD", true);
    vi.stubGlobal("navigator", { serviceWorker: {} });
    vi.stubGlobal("window", { location: { reload }, setInterval: vi.fn(), addEventListener });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("fetch", answer("1.1.0"));
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const update = await import("./app-update");
      update.startAppUpdates();
      expect(await update.applyAppUpdate()).toBe(true);
      now.mockReturnValue(131_000);
      update.dismissAppUpdate();
      mocks.register.mock.calls[0]?.[0]?.onNeedReload?.();
      await Promise.resolve();
      expect(reload).not.toHaveBeenCalled();
      expect(update.appUpdateState().dismissed).toBe(false);
      update.dismissAppUpdate();
      const preload = addEventListener.mock.calls.find(([name]) => name === "vite:preloadError");
      preload?.[1]();
      expect(update.appUpdateState()).toMatchObject({ available: true, dismissed: false });
      expect(reload).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
