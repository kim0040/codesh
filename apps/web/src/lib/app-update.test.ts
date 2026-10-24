import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => undefined }));

const answer = (version: string) =>
  vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 }));

describe("app update", () => {
  beforeEach(() => {
    vi.resetModules();
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
});
