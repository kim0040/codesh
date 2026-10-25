// Builds the web app, serves it, and checks the intro page in Chromium. Run it where Chromium is installed:
//   node apps/web/src/features/intro/tools/shots.mjs [--quick]
// Writes PNGs to <repo>/.box-out/intro/ and prints requests, console errors, CLS and LCP.
// Exits 1 when an external request, a console error or CLS >= 0.05 shows up.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build, preview } from "vite";

const root = resolve(import.meta.dirname, "../../../../../..");
const web = resolve(root, "apps/web");
const out = resolve(root, ".box-out/intro");
mkdirSync(out, { recursive: true });
const { chromium } = await import(
  pathToFileURL(resolve(root, "packages/ui/node_modules/playwright/index.mjs")).href
);

const quick = process.argv.includes("--quick");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);

await build({ root: web, logLevel: "warn" });
const assets = resolve(web, "dist/assets");
for (const file of readdirSync(assets).filter((name) => name.endsWith(".js"))) {
  const size = gzipSync(readFileSync(resolve(assets, file))).length;
  if (size > 2000) console.log(`js ${String(size).padStart(7)} B gz  ${file}`);
}
const server = await preview({
  root: web,
  logLevel: "warn",
  preview: { port: 4199, strictPort: true },
});
const base = "http://localhost:4199";

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const problems = [];
const note = (message) => {
  problems.push(message);
  console.error(`PROBLEM: ${message}`);
};

const INIT = () => {
  window.__cls = 0;
  window.__lcp = null;
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      window.__cls += entry.value;
      const sources = entry.sources.map((source) => {
        const node = source.node;
        return `${node?.nodeName}.${node?.className?.toString().slice(0, 30)}`;
      });
      window.__shifts.push(
        `${entry.value.toFixed(4)}@${Math.round(entry.startTime)}ms ${sources.join(" | ")}`,
      );
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    const entry = list.getEntries().at(-1);
    window.__lcp = {
      time: Math.round(entry.startTime),
      tag: entry.element?.tagName,
      text: entry.element?.textContent?.trim().slice(0, 24),
    };
  }).observe({ type: "largest-contentful-paint", buffered: true });
};

async function open({ width, scheme, locale = "ko", reduced = false, height = 900 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    reducedMotion: reduced ? "reduce" : "no-preference",
    deviceScaleFactor: 1,
  });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const tag = `${width}-${scheme}${locale === "en" ? "-en" : ""}${reduced ? "-reduced" : ""}`;
  await page.addInitScript(`localStorage.setItem("gachipad.locale", ${JSON.stringify(locale)})`);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol.startsWith("http")) {
      note(`[${tag}] external request ${request.url()}`);
    }
  });
  page.on("pageerror", (error) => note(`[${tag}] page error ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") note(`[${tag}] console ${message.text()}`);
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return { page, context, tag };
}

async function scrollThrough(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = (await page.viewportSize()).height / 2;
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function measure(page, tag) {
  const result = await page.evaluate(() => ({
    cls: window.__cls,
    lcp: window.__lcp,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
    shifts: window.__shifts,
  }));
  if (result.cls > 0.01) {
    for (const shift of result.shifts.filter((entry) => !entry.startsWith("0.0000"))) {
      console.log(`  shift ${shift}`);
    }
  }
  console.log(
    `${tag.padEnd(22)} cls ${result.cls.toFixed(4)}  lcp ${result.lcp?.time}ms <${result.lcp?.tag}> "${result.lcp?.text}"  overflow ${result.overflow}  height ${result.height}`,
  );
  if (result.cls >= 0.05) note(`[${tag}] CLS ${result.cls}`);
  if (result.overflow > 0) note(`[${tag}] horizontal overflow ${result.overflow}px`);
  if (result.lcp?.tag && !/^(H1|P|SPAN)$/.test(result.lcp.tag))
    note(`[${tag}] LCP is <${result.lcp.tag}>`);
}

const widths = quick ? [1440, 375] : [1440, 768, 375];
const schemes = quick ? ["dark", "light"] : ["dark", "light"];
for (const width of widths) {
  for (const scheme of schemes) {
    if (only && !`${width}-${scheme}`.includes(only)) continue;
    const { page, context, tag } = await open({ width, scheme });
    await page.waitForTimeout(5200);
    await page.screenshot({ path: `${out}/intro-${tag}-hero.png` });
    await scrollThrough(page);
    await measure(page, tag);
    await page.screenshot({ path: `${out}/intro-${tag}.png`, fullPage: true });
    if (width !== 1440 && scheme === "dark") {
      // Section by section, so narrow layouts can be inspected at full resolution.
      for (const selector of ["#how", "#fast", "#features", "#different", "#faq", "footer"]) {
        await page
          .locator(selector)
          .screenshot({ path: `${out}/intro-${width}-sec-${selector.replace("#", "")}.png` });
      }
    }
    await context.close();
  }
}

if (!quick && (!only || only === "en")) {
  // English, light, narrow; reduced motion; 320px; interactions.
  {
    const { page, context, tag } = await open({ width: 1440, scheme: "dark", locale: "en" });
    await page.waitForTimeout(4200);
    await scrollThrough(page);
    await measure(page, tag);
    await page.screenshot({ path: `${out}/intro-${tag}.png`, fullPage: true });
    await context.close();
  }
  {
    const { page, context, tag } = await open({ width: 375, scheme: "dark", locale: "en" });
    await page.waitForTimeout(1500);
    await scrollThrough(page);
    await measure(page, tag);
    await page.screenshot({ path: `${out}/intro-${tag}.png`, fullPage: true });
    await context.close();
  }
  {
    const { page, context, tag } = await open({ width: 320, scheme: "dark" });
    await page.waitForTimeout(1500);
    await scrollThrough(page);
    await measure(page, tag);
    await page.screenshot({ path: `${out}/intro-${tag}.png`, fullPage: true });
    await context.close();
  }
  {
    const { page, context, tag } = await open({ width: 1440, scheme: "light", reduced: true });
    await page.waitForTimeout(800);
    await measure(page, tag);
    await page.screenshot({ path: `${out}/intro-${tag}.png`, fullPage: true });
    // Reduced motion: no typing, the finished file is already there.
    const text = await page.locator(".cm-content").textContent();
    if (!text?.includes("LIMIT")) note(`[${tag}] demo is not showing the finished file`);
    await context.close();
  }
  {
    const { page, context } = await open({ width: 1440, scheme: "dark" });
    // Keyboard: Tab reaches the skip link first, then the header.
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    console.log(`first Tab stop: ${first}`);
    // Each way in, as drawn in the preview frame.
    await page.locator("#fast").scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    for (let way = 0; way < 5; way++) {
      await page.locator(".ix-way-btn").nth(way).click();
      await page.waitForTimeout(500);
      await page.locator("#fast .ix-wrap").screenshot({ path: `${out}/intro-way-${way + 1}.png` });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    // FAQ opens one answer at a time.
    await page.locator("#faq button").nth(1).click();
    const expanded = await page.locator("#faq button[aria-expanded=true]").count();
    if (expanded !== 1) note(`FAQ: ${expanded} answers open, expected 1`);
    // Language switch updates the heading and the document language.
    await page.getByRole("button", { name: "English" }).first().click();
    const title = await page.locator("h1").textContent();
    const lang = await page.evaluate(() => document.documentElement.lang);
    console.log(`after switch: h1="${title}" lang=${lang}`);
    if (lang !== "en") note("language switch did not update <html lang>");
    // The demo tabs switch files.
    await page.locator(".ix-ed-tab").nth(2).click();
    await page.waitForTimeout(600);
    const lines = await page.locator(".cm-line").count();
    console.log(`demo lines after selecting the third file: ${lines}`);
    await context.close();
  }
}

await browser.close();
server.httpServer.close();
if (problems.length) {
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("ok");
