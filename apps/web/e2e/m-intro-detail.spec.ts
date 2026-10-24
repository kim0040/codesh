import { expect, type Page, test } from "@playwright/test";
import { closeAll, newUser } from "./helpers";

async function openIntro(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.getByTestId("start-panel")).toBeVisible();
}

const hiddenReveals = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-reveal]")].filter(
        (node) => getComputedStyle(node).opacity !== "1",
      ).length,
  );

// Words that tie the copy to one kind of organisation or network (written as escapes so this file
// does not contain them itself).
const WHERE_WORDS = /\uc0ac\ub0b4|\ub0b4\ubd80\ub9dd|\ud68c\uc0ac|\u0069ntranet|\u0063ompany/i;

for (const locale of ["ko", "en"] as const) {
  test(`intro (${locale}): copy does not assume where it is deployed`, async ({ browser }) => {
    const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
    try {
      await user.context.addInitScript((value) => {
        localStorage.setItem("codesh.locale", value);
      }, locale);
      await openIntro(user.page);
      // Closed FAQ answers are hidden, so read the DOM text rather than what is rendered.
      const text = await user.page
        .locator("main, footer")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "").join(" "));
      expect(text).not.toMatch(WHERE_WORDS);
      expect(await user.page.title()).not.toMatch(WHERE_WORDS);
    } finally {
      await closeAll(user);
    }
  });
}

test("scroll reveal never leaves content invisible", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  const { page } = user;
  try {
    // Jumping straight to an anchor skips everything above it; none of it may stay blank.
    await openIntro(page, "/#faq");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [
              ...document.querySelectorAll<HTMLElement>("#how [data-reveal], #fast [data-reveal]"),
            ].filter((node) => getComputedStyle(node).opacity !== "1").length,
        ),
      )
      .toBe(0);

    // Scrolling down in steps reveals the rest.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 400) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => hiddenReveals(page)).toBe(0);
  } finally {
    await closeAll(user);
  }
});

test("reduced motion: every section is visible at once", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  try {
    await user.page.emulateMedia({ reducedMotion: "reduce" });
    await openIntro(user.page);
    expect(await hiddenReveals(user.page)).toBe(0);
    await expect(user.page.locator(".ix-stage-art")).toHaveCSS(
      "animation-duration",
      /^(0s|1e-05s)$/,
    );
  } finally {
    await closeAll(user);
  }
});

test("the language chips switch the example and show its own highlighting", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  const { page } = user;
  try {
    await openIntro(page);
    const tile = page.locator(".ix-fx-highlight");
    await tile.scrollIntoViewIfNeeded();
    const typescript = tile.getByRole("button", { name: "TypeScript" });
    const python = tile.getByRole("button", { name: "Python" });
    await expect(typescript).toHaveAttribute("aria-pressed", "true");
    await expect(tile.locator(".ix-code")).toContainText("export function total");

    // Keyboard: chips are real buttons.
    await python.focus();
    await page.keyboard.press("Enter");
    await expect(python).toHaveAttribute("aria-pressed", "true");
    await expect(typescript).toHaveAttribute("aria-pressed", "false");
    await expect(tile.locator(".ix-code")).toContainText("def total");
    // Token colours come from the editor theme, so keywords are not the plain text colour.
    const colours = await tile
      .locator('.ix-code .tk[data-k="keyword"]')
      .first()
      .evaluate((node) => getComputedStyle(node).color);
    const plain = await tile.locator(".ix-code").evaluate((node) => getComputedStyle(node).color);
    expect(colours).not.toBe(plain);
  } finally {
    await closeAll(user);
  }
});

test("the keyboard tile lists shortcuts as key caps", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  try {
    await openIntro(user.page);
    const tile = user.page.locator(".ix-fx-keys");
    await expect(tile.locator("kbd")).toHaveCount(11);
    await expect(tile.locator("dt")).toHaveCount(4);
  } finally {
    await closeAll(user);
  }
});

for (const locale of ["ko", "en"] as const) {
  test(`320px (${locale}): header controls share one row and no section overflows`, async ({
    browser,
  }) => {
    const user = await newUser(browser, "Maya", { viewport: { width: 320, height: 700 } });
    const { page } = user;
    try {
      await user.context.addInitScript((value) => {
        localStorage.setItem("codesh.locale", value);
      }, locale);
      await openIntro(page);
      const tops = await page
        .locator("header.ix-header button, header.ix-header .ix-brand")
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(12);

      // The page does not scroll sideways, and no part of a section pokes out of the viewport
      // (the start panel scrolls its own recent shares, so the hero is left to the first check).
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".ix-section *, .ix-footer *")]
          .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
          .filter((node) => !node.closest(".ix-code"))
          .map((node) => `${node.tagName}.${String(node.className).slice(0, 30)}`)
          .slice(0, 5),
      );
      expect(wide).toEqual([]);
    } finally {
      await closeAll(user);
    }
  });
}
