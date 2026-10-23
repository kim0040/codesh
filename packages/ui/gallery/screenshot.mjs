// Renders the gallery in Chromium and writes PNGs to <repo>/.box-out/gallery-*.png.
//   scripts/box pnpm --filter @codesh/ui gallery:shots
// Doubles as a smoke test: it fails on console errors, checks PinInput paste, dialogs, the toast
// stack and the 320px layout (no horizontal page scroll).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const out = resolve(import.meta.dirname, "../../../.box-out");
mkdirSync(out, { recursive: true });

const server = await createServer({
  configFile: resolve(import.meta.dirname, "vite.config.ts"),
  logLevel: "warn",
});
await server.listen();
const base = `http://localhost:${server.config.server.port}`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
const shots = [];
let failed = false;

const check = (ok, message) => {
  if (ok) return;
  failed = true;
  console.error(`FAIL: ${message}`);
};

async function open(viewport, theme, view, { reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    reducedMotion,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`[${theme}/${view}] ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`[${theme}/${view}] ${message.text()}`);
  });
  await page.goto(`${base}/?view=${view}&theme=${theme}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (view === "editors") {
    await page.waitForFunction(
      () => document.querySelectorAll("[data-preview=ready]").length >= 40,
      null,
      { timeout: 60_000 },
    );
    // CodeMirror measures editors when they scroll into view; visit each one before the full-page shot.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += viewport.height / 2) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(60);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(250);
  return { page, context };
}

async function shot(page, name, options = {}) {
  const path = `${out}/gallery-${name}.png`;
  await page.screenshot({ path, ...options });
  shots.push(path);
}

// `GALLERY_ONLY=editors` re-shoots just the editor-theme pages while iterating on them.
const only = process.env.GALLERY_ONLY;
for (const theme of ["dark", "light"]) {
  if (only === "editors") {
    const { page, context } = await open({ width: 1280, height: 900 }, theme, "editors");
    await shot(page, `editors-${theme}`, { fullPage: true });
    await context.close();
    continue;
  }
  const desktop = { width: 1280, height: 900 };

  // Full pages.
  for (const view of ["components", "tokens", "editors"]) {
    const { page, context } = await open(desktop, theme, view);
    await shot(page, `${view}-${theme}`, { fullPage: true });
    if (view === "tokens") {
      const failing = await page.$$eval(
        "main [style*='color']",
        (nodes) => nodes.filter((n) => n.querySelector(".underline")).length,
      );
      check(failing === 0, `${failing} token pairs under their contrast minimum (${theme})`);
    }
    await context.close();
  }

  // Components: interaction states.
  {
    const { page, context } = await open(desktop, theme, "components");
    const panelOf = (section) => page.locator(`#${section} [data-panel=dark]`);
    const panel = panelOf("inputs");

    // PinInput: paste a full code, expect every box filled and the status line to react.
    const digits = panel.locator("input[aria-label*='번째']");
    check((await digits.count()) === 6, "PinInput renders 6 boxes");
    await digits.first().focus();
    await page.evaluate(() => {
      const target = document.activeElement;
      const data = new DataTransfer();
      data.setData("text/plain", "482 913");
      target?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await page.waitForTimeout(150);
    const values = await digits.evaluateAll((nodes) => nodes.map((n) => n.value).join(""));
    check(values === "482913", `PinInput paste filled "${values}" instead of 482913`);
    const pinGroup = panel.locator("[aria-label='참여 코드']");
    await pinGroup.scrollIntoViewIfNeeded();
    const pinPath = `${out}/gallery-pin-paste-${theme}.png`;
    await pinGroup.screenshot({ path: pinPath });
    shots.push(pinPath);

    // Select, menu, popover open states.
    await panelOf("select-switch").getByRole("combobox").first().click();
    await page.waitForTimeout(260);
    await shot(page, `select-open-${theme}`);
    await page.keyboard.press("Escape");

    const overlays = panelOf("overlays");
    await overlays.getByRole("button", { name: "메뉴 열기" }).click();
    await page.waitForTimeout(260);
    check((await page.getByRole("menu").count()) === 1, "menu opens");
    await shot(page, `menu-open-${theme}`);
    await page.keyboard.press("Escape");

    await overlays.getByRole("button", { name: "새 공유" }).click();
    await page.waitForTimeout(260);
    await shot(page, `popover-open-${theme}`);
    await page.keyboard.press("Escape");

    // The tooltip that the gallery keeps open would float above modal layers; hide it for those shots.
    await page.addStyleTag({
      content: "[data-radix-popper-content-wrapper]:has(.ui-tip) { display: none !important; }",
    });

    // Dialog: focus moves in, Escape closes and returns focus to the trigger.
    const dialogTrigger = overlays.locator("[data-open=dialog]");
    await dialogTrigger.click();
    await page.waitForTimeout(300);
    check((await page.getByRole("dialog").count()) === 1, "dialog opens");
    check(
      await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")),
      "dialog traps focus",
    );
    await shot(page, `dialog-${theme}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check((await page.getByRole("dialog").count()) === 0, "dialog closes with Escape");
    check(
      await dialogTrigger.evaluate((el) => el === document.activeElement),
      "focus returns to dialog trigger",
    );

    // Sheets.
    await overlays.locator("[data-open=sheet]").click();
    await page.waitForTimeout(400);
    await shot(page, `sheet-${theme}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Toast stack: collapsed, then expanded on hover.
    await overlays.locator("[data-open=toast]").click();
    await page.waitForTimeout(700);
    check((await page.locator("[data-n]").count()) === 3, "three toasts are stacked");
    await shot(page, `toast-stack-${theme}`, { clip: { x: 880, y: 560, width: 400, height: 340 } });
    await page.mouse.move(1100, 840);
    await page.waitForTimeout(500);
    await shot(page, `toast-expanded-${theme}`, {
      clip: { x: 880, y: 400, width: 400, height: 500 },
    });
    await context.close();
  }

  // Narrow: 320px wide, no horizontal page scroll; bottom sheet and dialog fit.
  {
    const { page, context } = await open({ width: 320, height: 720 }, theme, "components");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(overflow <= 0, `320px layout scrolls horizontally by ${overflow}px (${theme})`);
    await shot(page, `320-components-${theme}`, { fullPage: true });
    await page.addStyleTag({
      content: "[data-radix-popper-content-wrapper]:has(.ui-tip) { display: none !important; }",
    });
    await page.locator("[data-panel=dark] [data-open=sheet-bottom]").click();
    await page.waitForTimeout(450);
    await shot(page, `320-bottom-sheet-${theme}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.locator("[data-panel=dark] [data-open=dialog]").click();
    await page.waitForTimeout(300);
    await shot(page, `320-dialog-${theme}`);
    await context.close();
  }

  // Tokens at 320 as well.
  {
    const { page, context } = await open({ width: 320, height: 720 }, theme, "tokens");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(overflow <= 0, `320px tokens view scrolls horizontally by ${overflow}px (${theme})`);
    await shot(page, `320-tokens-${theme}`, { fullPage: true });
    await context.close();
  }
}

// Reduced motion: transitions collapse, nothing should be mid-animation after one frame.
{
  const { page, context } = await open({ width: 1280, height: 900 }, "dark", "components", {
    reducedMotion: "reduce",
  });
  const durations = await page.evaluate(() =>
    ["--duration-fast", "--duration-normal", "--duration-slow"].map((name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    ),
  );
  check(
    durations.every((d) => d === "0.01ms"),
    `motion tokens under reduced motion: ${durations.join(", ")}`,
  );
  await context.close();
}

await browser.close();
await server.close();

if (errors.length) {
  failed = true;
  console.error(`Console errors:\n${[...new Set(errors)].join("\n")}`);
}
console.log(shots.join("\n"));
process.exit(failed ? 1 : 0);
