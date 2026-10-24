import { expect, type Page, test } from "@playwright/test";
import { closeAll, newUser } from "./helpers";

async function openIntro(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("start-panel")).toBeVisible();
}

/** The header counts as hidden once it has slid fully above the viewport. */
async function headerTop(page: Page): Promise<{ top: number; bottom: number }> {
  const box = await page.locator("header.ix-header").boundingBox();
  expect(box).not.toBeNull();
  return { top: box?.y ?? 0, bottom: (box?.y ?? 0) + (box?.height ?? 0) };
}

const expectHidden = (page: Page) =>
  expect.poll(async () => (await headerTop(page)).bottom).toBeLessThanOrEqual(0);
const expectShown = (page: Page) =>
  expect.poll(async () => (await headerTop(page)).top).toBeGreaterThanOrEqual(0);

test("the intro header hides on scroll down, returns on scroll up and when focused", async ({
  browser,
}) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  const { page } = user;
  try {
    await openIntro(page);
    await expectShown(page);

    // Near the top it stays put, and it has no backdrop yet.
    await page.evaluate(() => window.scrollTo(0, 20));
    await expectShown(page);

    await page.evaluate(() => window.scrollTo(0, 1500));
    await expectHidden(page);

    // A tiny wobble up does not bring it back; a real scroll up does.
    await page.evaluate(() => window.scrollBy(0, -3));
    await expectHidden(page);
    await page.evaluate(() => window.scrollBy(0, -40));
    await expectShown(page);
    await expect(page.locator("header.ix-header")).toHaveAttribute("data-raised", "");
    await expect(page.locator("header.ix-header")).toHaveCSS("border-bottom-color", /rgb/);

    await page.evaluate(() => window.scrollBy(0, 400));
    await expectHidden(page);

    // Keyboard: tabbing into the hidden header shows it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      if (await page.locator("header.ix-header").evaluate((el) => el.matches(":focus-within")))
        break;
    }
    await expect(
      page.locator("header.ix-header a:focus, header.ix-header button:focus"),
    ).toHaveCount(1);
    await expectShown(page);

    // Back at the top it is always shown, whatever happened before.
    await page.locator("header.ix-header :focus").evaluate((el) => (el as HTMLElement).blur());
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectShown(page);
  } finally {
    await closeAll(user);
  }
});

test("anchor targets clear the sticky header", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  try {
    await openIntro(user.page);
    const header = (await headerTop(user.page)).bottom;
    for (const id of ["how", "features", "faq"]) {
      const margin = await user.page
        .locator(`section#${id}`)
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).scrollMarginTop));
      expect(margin, id).toBeGreaterThanOrEqual(header);
    }
  } finally {
    await closeAll(user);
  }
});

test("reduced motion: the header changes without sliding", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  try {
    await user.page.emulateMedia({ reducedMotion: "reduce" });
    await openIntro(user.page);
    // No slide: the duration is zero (or the 0.01ms the reduced-motion reset leaves).
    await expect(user.page.locator("header.ix-header")).toHaveCSS(
      "transition-duration",
      /^(0s|1e-05s)$/,
    );
    await user.page.evaluate(() => window.scrollTo(0, 1500));
    await expectHidden(user.page);
    await user.page.evaluate(() => window.scrollBy(0, -60));
    await expectShown(user.page);
  } finally {
    await closeAll(user);
  }
});

test("header and footer theme controls switch the page and stay in sync", async ({ browser }) => {
  const user = await newUser(browser, "Maya", { viewport: { width: 1280, height: 800 } });
  const { page } = user;
  try {
    await openIntro(page);
    const header = page.locator("header.ix-header");
    const footer = page.locator("footer.ix-footer");
    const html = page.locator("html");

    await header.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(header.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(footer.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(footer.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await header.getByRole("button", { name: "Dark" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(footer.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await page.evaluate(() => localStorage.getItem("codesh.theme"))).toBe("dark");

    // The other way round: the footer drives the header.
    await footer.getByRole("button", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(header.getByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await header.getByRole("button", { name: "Match system" }).click();
    await expect(html).not.toHaveAttribute("data-theme", /.+/);
    await expect(footer.getByRole("button", { name: "Match system" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await page.evaluate(() => localStorage.getItem("codesh.theme"))).toBeNull();

    // Keyboard operable with a visible focus ring.
    await header.getByRole("button", { name: "Dark" }).focus();
    await page.keyboard.press("Enter");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("Shift+Tab");
    await expect(header.getByRole("button", { name: "Light" })).toBeFocused();
    await expect(header.getByRole("button", { name: "Light" })).toHaveCSS("outline-style", "solid");
  } finally {
    await closeAll(user);
  }
});

for (const locale of ["en", "ko"] as const) {
  test(`320px (${locale}): the header fits without horizontal overflow`, async ({ browser }) => {
    const user = await newUser(browser, "Maya", { viewport: { width: 320, height: 700 } });
    const { page } = user;
    try {
      await user.context.addInitScript((value) => {
        localStorage.setItem("codesh.locale", value);
      }, locale);
      await openIntro(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      const row = await page.locator(".ix-header-row").boundingBox();
      const last = await page.locator("header.ix-header button").last().boundingBox();
      expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(320);
      expect(row?.width ?? 0).toBeLessThanOrEqual(320);
      // Every header control is on one row and inside the viewport.
      for (const button of await page.locator("header.ix-header button").all()) {
        const box = await button.boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
      }
      await page
        .locator("header.ix-header")
        .getByRole("button", { name: /Dark|다크/ })
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    } finally {
      await closeAll(user);
    }
  });
}
