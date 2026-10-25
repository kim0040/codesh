import { expect, test } from "@playwright/test";
import { BASE_URL } from "./env";

test.use({ storageState: { cookies: [], origins: [] } });

// legacy codesh name (1.0.x); remove in 2.0
test("migrates browser state before startup and keeps legacy IndexedDB and tab messages", async ({
  page,
  context,
}) => {
  await context.route("**/legacy-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  const oldTab = await context.newPage();
  await oldTab.goto("/legacy-seed");
  await oldTab.evaluate(async () => {
    localStorage.setItem("codesh.theme", "light");
    localStorage.setItem("codesh.locale", "en");
    localStorage.setItem("codesh.tour", "9999");
    localStorage.setItem("codesh.prefs", JSON.stringify({ offlineCopy: "yes", keymap: "vim" }));
    localStorage.setItem("codesh.device.copy:oldshare", "1");
    localStorage.setItem("codesh.diagnostics.enabled", "false");
    const at = new Date().toISOString();
    localStorage.setItem(
      "codesh.diagnostics.v1",
      JSON.stringify([
        {
          source: "client",
          kind: "api_failure",
          level: "error",
          firstAt: at,
          lastAt: at,
          count: 1,
          details: { route: "/api/session", status: 500 },
        },
      ]),
    );
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("codesh:doc:oldshare", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("updates", { autoIncrement: true });
        request.result.createObjectStore("custom").put("saved-edit-key", "legacy-key");
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const channel = new BroadcastChannel("codesh:device");
    channel.onmessage = (event) => {
      if (event.data.type === "unsent?")
        channel.postMessage({ type: "unsent", ask: event.data.ask });
    };
  });
  await page.goto("/legacy-seed");
  await page.evaluate(() => sessionStorage.setItem("codesh.admin", "saved-admin-token"));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => ({
      locale: localStorage.getItem("gachipad.locale"),
      tour: localStorage.getItem("gachipad.tour"),
      prefs: JSON.parse(localStorage.getItem("gachipad.prefs") ?? "{}"),
      diagnostics: localStorage.getItem("gachipad.diagnostics.enabled"),
      admin: sessionStorage.getItem("gachipad.admin"),
    })),
  ).toEqual({
    locale: "en",
    tour: "9999",
    prefs: { offlineCopy: "yes", keymap: "vim" },
    diagnostics: "false",
    admin: "saved-admin-token",
  });
  expect(
    await page.evaluate(async () => {
      const path = "/src/lib/device.ts";
      const device = await import(/* @vite-ignore */ path);
      return { name: device.idbName("oldshare"), unsent: await device.hasUnsentEdits() };
    }),
  ).toEqual({ name: "codesh:doc:oldshare", unsent: true });
  expect(
    await page.evaluate(async () => {
      const path = "/src/lib/diagnostics.ts";
      return (await import(/* @vite-ignore */ path)).diagnosticsState();
    }),
  ).toEqual({ enabled: false, count: 1 });
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("codesh:doc:oldshare");
          request.onsuccess = () => {
            const transaction = request.result.transaction("custom", "readonly");
            const get = transaction.objectStore("custom").get("legacy-key");
            get.onsuccess = () => resolve(get.result);
            transaction.oncomplete = () => request.result.close();
          };
          request.onerror = () => reject(request.error);
        }),
    ),
  ).toBe("saved-edit-key");
  await oldTab.close();
});

// legacy codesh name (1.0.x); remove in 2.0
test("keeps a signed old cookie's guest identity and accepts a cached old client's header", async ({
  context,
  page,
}) => {
  const first = await context.request.get("/api/session");
  const identity = await first.json();
  const cookie = (await context.cookies()).find((item) => item.name === "gachipad_sid");
  expect(cookie).toBeDefined();
  await context.clearCookies();
  await context.addCookies([{ name: "codesh_sid", value: cookie?.value ?? "", url: BASE_URL }]);
  const migrated = await context.request.get("/api/session");
  expect((await migrated.json()).clientId).toBe(identity.clientId);
  expect((await context.cookies()).some((item) => item.name === "gachipad_sid")).toBe(true);
  const share = await context.request.post("/api/shares", {
    headers: { "X-Codesh": "1" },
    data: {},
  });
  expect(share.ok()).toBe(true);
  await page.goto("/");
});
