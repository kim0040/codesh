// Run on the dev box: node deploy/verify-security.mjs <origin>
// Against a production Caddy image, in an isolated compose project; no external request is allowed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve("apps/web/package.json"));
const { chromium, expect } = require("@playwright/test");
const origin = process.argv[2] ?? "http://127.0.0.1:18180";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: origin,
  locale: "en-US",
  extraHTTPHeaders: { "X-Codesh": "1" },
});
const violations = [];
const external = [];
const workers = [];
context.on("serviceworker", (worker) => workers.push(worker.url()));
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["data:", "blob:"].includes(url.protocol) || url.origin === origin) return route.continue();
  external.push(url.origin);
  return route.abort();
});
await context.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) =>
    window.__cspViolations.push({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
      line: event.lineNumber,
      sample: event.sample,
    }),
  );
});
const page = await context.newPage();
page.on("worker", (worker) => workers.push(worker.url()));
page.on("console", (message) => {
  if (/violat.*content security policy|refused.*content security policy/i.test(message.text()))
    violations.push(message.text().slice(0, 200));
});
const checkPage = async () => {
  violations.push(...(await page.evaluate(() => window.__cspViolations)));
};
try {
  const response = await page.goto("/");
  assert(response.headers()["content-security-policy"].includes("script-src 'self'"));
  await expect(page.getByTestId("new-share")).toBeVisible();
  await checkPage();
  const created = await context.request.post("/api/shares", {
    data: {
      title: "Security production verification",
      language: "javascript",
      files: [{ path: "main.js", content: "const x={a:1};" }],
    },
  });
  assert.equal(created.status(), 200);
  const { id } = await created.json();
  await page.goto(`/${id}`);
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  await expect(page.locator(".cm-content")).toContainText("const x");
  await checkPage();
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("qr")).toBeVisible();
  assert(await page.getByTestId("qr").evaluate((img) => img.complete && img.naturalWidth > 0));
  await checkPage();
  await page.keyboard.press("Escape");
  await page.getByTestId("menu-button").click();
  await page.getByRole("menuitem", { name: "Format code" }).click();
  await expect(page.locator(".cm-content")).toContainText("const x = { a: 1 };");
  await checkPage();
  assert.equal(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const url = URL.createObjectURL(
            new Blob(['postMessage("worker-ok")'], { type: "application/javascript" }),
          );
          const worker = new Worker(url);
          worker.onmessage = (event) => {
            worker.terminate();
            URL.revokeObjectURL(url);
            resolve(event.data);
          };
          worker.onerror = reject;
        }),
    ),
    "worker-ok",
  );
  await expect
    .poll(
      async () => (await (await context.request.get(`/api/shares/${id}/history`)).json()).length,
      { timeout: 45000 },
    )
    .toBeGreaterThan(0);
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-view")).toBeVisible();
  await checkPage();
  await page.keyboard.press("Escape");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          navigator.serviceWorker.getRegistration().then((registration) => !!registration?.active),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByTestId("new-share")).toBeVisible();
  await checkPage();
  assert.equal(external.length, 0, `external runtime requests: ${external.join(",")}`);
  assert.equal(violations.length, 0, JSON.stringify(violations));
  console.log(
    JSON.stringify({
      origin,
      pages: [
        "intro",
        "editor/WebSocket",
        "share/QR",
        "formatter chunks and blob worker",
        "owner history",
        "service worker offline intro",
      ],
      cspViolations: violations.length,
      externalRequests: external.length,
      workers,
    }),
  );
} finally {
  await context.close();
  await browser.close();
}
