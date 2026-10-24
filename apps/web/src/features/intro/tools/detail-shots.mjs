// Full-page intro screenshots for before/after comparison, plus a check that the scroll reveal
// never leaves content invisible. Run it where Chromium is installed:
//   node apps/web/src/features/intro/tools/detail-shots.mjs <label> [--skip-build]
// Writes <repo>/.box-out/intro-detail/<label>-<ko|en>-<dark|light>-<width>[-natural].png.
// The plain PNGs force every reveal visible; "-natural" ones are scrolled through like a visitor
// would, so they show what a real visit looks like. Exits 1 on an external request, a console
// error, horizontal overflow, or an element that is still invisible after scrolling past it.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build, preview } from "vite";

const root = resolve(import.meta.dirname, "../../../../../..");
const web = resolve(root, "apps/web");
const label = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "shot";
const out = resolve(root, ".box-out/intro-detail");
mkdirSync(out, { recursive: true });
const { chromium } = await import(
  pathToFileURL(resolve(root, "packages/ui/node_modules/playwright/index.mjs")).href
);

if (!process.argv.includes("--skip-build")) await build({ root: web, logLevel: "warn" });
const assets = resolve(web, "dist/assets");
for (const file of readdirSync(assets).filter((name) => name.endsWith(".js"))) {
  const size = gzipSync(readFileSync(resolve(assets, file))).length;
  if (size > 2000) console.log(`js ${String(size).padStart(7)} B gz  ${file}`);
}
const server = await preview({
  root: web,
  logLevel: "warn",
  preview: { port: 4198, strictPort: true },
});
const base = "http://localhost:4198";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const problems = [];
const note = (message) => {
  problems.push(message);
  console.error(`PROBLEM: ${message}`);
};

const CONFIGS = [
  { locale: "ko", scheme: "dark", width: 1440 },
  { locale: "ko", scheme: "light", width: 1440 },
  { locale: "ko", scheme: "dark", width: 320 },
  { locale: "en", scheme: "light", width: 1440 },
];

for (const { locale, scheme, width } of CONFIGS) {
  const tag = `${locale}-${scheme}-${width}`;
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 700 : 900 },
    colorScheme: scheme,
    reducedMotion: "no-preference",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript(`localStorage.setItem("codesh.locale", ${JSON.stringify(locale)})`);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol.startsWith("http")) {
      note(`[${tag}] external request ${request.url()}`);
    }
  });
  page.on("pageerror", (error) => note(`[${tag}] page error ${error.message}`));
  page.on("console", (message) => {
    // The API is not running here, so the preview proxy answers 502 for /api; that is expected.
    if (message.type() === "error" && !/status of 502/.test(message.text()))
      note(`[${tag}] console ${message.text()}`);
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(".cm-content", { timeout: 10000 });
  await page.waitForTimeout(5200);

  // Scroll through at a visitor's pace, then look for content that never appeared.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = (await page.viewportSize()).height / 2;
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(900);
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll("[data-reveal]")]
      .filter((node) => !("in" in node.dataset) || getComputedStyle(node).opacity !== "1")
      .map((node) => `${node.tagName}.${String(node.className).slice(0, 24)}`),
  );
  if (hidden.length) note(`[${tag}] still hidden after scrolling past: ${hidden.join(", ")}`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) note(`[${tag}] horizontal overflow ${overflow}px`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${label}-${tag}-natural.png`, fullPage: true });

  // Same page with every reveal forced in, for the comparison shots.
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("[data-reveal]")) node.dataset.in = "";
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${label}-${tag}.png`, fullPage: true });
  // WCAG contrast of every visible text node against the first opaque background behind it.
  const low = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const toRgba = (value) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const luminance = ([r, g, b]) => {
      const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const backdrop = (node) => {
      for (let el = node; el; el = el.parentElement) {
        const [r, g, b, a] = toRgba(getComputedStyle(el).backgroundColor);
        if (a > 0.95) return [r, g, b];
      }
      return toRgba(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    };
    const out = [];
    let checked = 0;
    const walker = document.createTreeWalker(document.querySelector(".ix"), NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const el = text.parentElement;
      if (el.closest(".cm-editor, [aria-hidden=true] .ix-qr") || el.closest(".ix-sr")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      checked++;
      const [fr, fg, fb, fa] = toRgba(style.color);
      const back = backdrop(el);
      const mix = [fr, fg, fb].map((v, i) => v * fa + back[i] * (1 - fa));
      const l1 = luminance(mix);
      const l2 = luminance(back);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        out.push(
          `${ratio.toFixed(2)} "${text.textContent.trim().slice(0, 28)}" <${el.className.toString().slice(0, 24)}>`,
        );
      }
    }
    out.unshift(`checked ${checked} text nodes`);
    return out;
  });
  console.log(`${tag}: ${low.shift()}`);
  for (const entry of low) note(`[${tag}] low contrast ${entry}`);
  if (tag === "ko-dark-1440") {
    // Each way in, as drawn in the fixed preview frame.
    await page.locator("#fast").scrollIntoViewIfNeeded();
    for (let way = 0; way < 5; way++) {
      await page.locator(".ix-way-btn").nth(way).click();
      await page.waitForTimeout(500);
      await page.locator(".ix-stage").screenshot({ path: `${out}/${label}-way-${way + 1}.png` });
    }
    // The highlight tile with another language picked.
    await page.locator(".ix-chip", { hasText: "Python" }).click();
    await page.waitForTimeout(400);
    await page
      .locator(".ix-fx-highlight")
      .screenshot({ path: `${out}/${label}-highlight-python.png` });
  }
  console.log(`${tag.padEnd(16)} height ${height}  overflow ${overflow}`);
  await context.close();
}

await browser.close();
server.httpServer.close();
if (problems.length) {
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log("ok");
