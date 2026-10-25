import { type Browser, expect, type Page, test } from "@playwright/test";
import { BASE_URL } from "./env";
import {
  closeAll,
  createShare,
  newUser,
  openShareDialog,
  type User,
  waitForEditor,
} from "./helpers";

/** After the editor is up, the tour waits for a quiet moment (700ms) before it comes in. */
const QUIET_MS = 1500;

/** A browser profile that has never seen the tour: the config seeds the key, this one does not. */
async function firstTimer(
  browser: Browser,
  label: string,
  options: {
    viewport?: { width: number; height: number };
    reducedMotion?: "reduce" | "no-preference";
    colorScheme?: "dark" | "light";
    forcedColors?: "active" | "none";
    contrast?: "more" | "no-preference";
  } = {},
): Promise<User> {
  const name = `${label}${Date.now().toString(36).slice(-4)}`;
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: "en-US",
    extraHTTPHeaders: { "X-Gachipad": "1" },
    storageState: { cookies: [], origins: [] },
    ...options,
  });
  const response = await context.request.patch("/api/session", { data: { name } });
  expect(response.ok()).toBe(true);
  return { context, page: await context.newPage(), name };
}

/** The editor's one-time device question goes first; the tour waits until it is answered. */
async function answerDeviceQuestion(page: Page): Promise<void> {
  await page.getByTestId("device-choice-skip").click();
  await expect(page.getByTestId("device-choice")).toBeHidden();
}

const tourDialog = (page: Page) => page.getByTestId("tour");

/** Every transition and entry animation of the popover is over, so its box is where it stays. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tour = document.querySelector('[data-testid="tour"]');
    return tour !== null && tour.getAnimations().length === 0;
  });
}

async function counter(page: Page): Promise<string> {
  return (await page.getByTestId("tour-step").textContent()) ?? "";
}

async function storedVersion(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("gachipad.tour"));
}

async function walkToDone(page: Page): Promise<number> {
  let steps = 1;
  while ((await page.getByTestId("tour-next").textContent()) !== "Done") {
    await page.keyboard.press("Enter");
    steps++;
    await expect(page.getByTestId("tour-step")).toContainText(`${steps} /`);
  }
  return steps;
}

test("a first visit gets the tour, keyboard only, once; Settings replays it", async ({
  browser,
}) => {
  const user = await firstTimer(browser, "Tour");
  const { page } = user;
  try {
    await createShare(page);

    // Not while the device question is open.
    await expect(page.getByTestId("device-choice")).toBeVisible();
    await page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(page)).toBeHidden();

    await answerDeviceQuestion(page);
    await expect(tourDialog(page)).toBeVisible();
    await expect(tourDialog(page)).toHaveAttribute("role", "dialog");
    await expect(page.getByRole("dialog", { name: "Invite others" })).toBeVisible();
    await expect(page.getByTestId("tour-step")).toHaveText("1 / 5");
    // Focus moved into the popover, onto the button Enter walks forward with.
    await expect(page.getByTestId("tour-next")).toBeFocused();
    await expect(page.getByTestId("tour-back")).toHaveCount(0);

    // Back and forth by keyboard; the live region announces the step.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tour-step")).toHaveText("2 / 5");
    await expect(tourDialog(page).getByRole("status")).toContainText("Step 2 of 5: Who is here");
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("tour-back")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tour-step")).toHaveText("1 / 5");
    await expect(page.getByTestId("tour-next")).toBeFocused();

    // Focus cannot leave the popover.
    for (let press = 0; press < 7; press++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => document.activeElement?.closest('[data-testid="tour"]') !== null),
      ).toBe(true);
    }

    // An Escape that cancels an input-method composition does not close the tour.
    await page.getByTestId("tour-next").focus();
    await page.evaluate(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(tourDialog(page)).toBeVisible();

    expect(await walkToDone(page)).toBe(5);
    await expect(page.getByTestId("tour-next")).toHaveText("Done");
    await expect(page.getByTestId("tour-skip")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(tourDialog(page)).toBeHidden();
    expect(await storedVersion(page)).toBe("1");

    // Seen: a reload does not bring it back.
    await page.reload();
    await waitForEditor(page);
    await page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(page)).toBeHidden();

    // Settings > Replay tutorial plays it again from the start.
    await page.getByTestId("settings-button").click();
    await page.getByTestId("replay-tour").click();
    await expect(tourDialog(page)).toBeVisible();
    await expect(page.getByTestId("tour-step")).toHaveText("1 / 5");
    await expect(page.getByTestId("tour-next")).toBeFocused();

    // Escape closes it, and counts as seen.
    await page.keyboard.press("Escape");
    await expect(tourDialog(page)).toBeHidden();
    expect(await storedVersion(page)).toBe("1");
  } finally {
    await closeAll(user);
  }
});

test("Skip ends the tour and it stays gone on the next visit", async ({ browser }) => {
  const user = await firstTimer(browser, "Skip");
  const { page } = user;
  try {
    await createShare(page);
    await answerDeviceQuestion(page);
    await expect(tourDialog(page)).toBeVisible();
    await page.getByTestId("tour-next").click();
    await page.getByTestId("tour-skip").click();
    await expect(tourDialog(page)).toBeHidden();
    expect(await storedVersion(page)).toBe("1");
    // Another share in the same browser: still no tour.
    await createShare(page);
    await page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(page)).toBeHidden();
  } finally {
    await closeAll(user);
  }
});

test("a browser that already saw the tour, and the marketing pages, never show it", async ({
  browser,
}) => {
  // newUser profiles start with the tour seen (playwright.config.ts).
  const returning = await newUser(browser, "Back");
  const fresh = await firstTimer(browser, "Pages");
  try {
    await createShare(returning.page);
    await answerDeviceQuestion(returning.page);
    await returning.page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(returning.page)).toBeHidden();

    // A first-timer on the home page and the guide: the tour belongs to the editor.
    for (const path of ["/", "/guide/how"]) {
      await fresh.page.goto(path);
      await expect(fresh.page.getByRole("main")).toBeVisible();
      await fresh.page.waitForTimeout(QUIET_MS);
      await expect(tourDialog(fresh.page)).toBeHidden();
    }
    expect(await storedVersion(fresh.page)).toBeNull();
  } finally {
    await closeAll(returning, fresh);
  }
});

test("it waits while another dialog is open", async ({ browser }) => {
  const user = await firstTimer(browser, "Wait");
  const { page } = user;
  try {
    await createShare(page);
    await answerDeviceQuestion(page);
    // Inside the quiet moment before the tour: a dialog opens and the tour holds back.
    await openShareDialog(page);
    await page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(tourDialog(page)).toBeVisible();
  } finally {
    await closeAll(user);
  }
});

test("it waits while the editor's own dialogs are open, and does not take their focus", async ({
  browser,
}) => {
  const user = await firstTimer(browser, "Own");
  const { page } = user;
  try {
    await createShare(page);
    await answerDeviceQuestion(page);
    // New file opens right away, inside the quiet moment before the tour.
    await page.getByTestId("add-file").click();
    const dialog = page.getByRole("dialog", { name: "New file" });
    const input = page.getByTestId("file-name-input");
    await expect(input).toBeFocused();
    await input.fill("notes.md");
    await page.waitForTimeout(QUIET_MS);
    await expect(tourDialog(page)).toHaveCount(0);
    // The dialog is still the active one: visible to assistive technology, focus and text kept.
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-hidden", "true");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("notes.md");

    // Closing it lets the tour in, once.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(tourDialog(page)).toBeVisible();
    await expect(page.getByTestId("tour-next")).toBeFocused();
  } finally {
    await closeAll(user);
  }
});

test("a viewer's tour leaves out what a viewer cannot do", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const viewer = await firstTimer(browser, "Viewer");
  try {
    const id = await createShare(owner.page);
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("access-view").click();
    await patched;
    await dialog.getByRole("tab", { name: "Code and QR" }).click();
    const viewUrl = await dialog.getByTestId("share-link").inputValue();

    await viewer.page.goto(new URL(viewUrl).pathname);
    await waitForEditor(viewer.page);
    await expect(viewer.page.getByTestId("banner-readonly")).toBeVisible();
    await answerDeviceQuestion(viewer.page);
    await expect(tourDialog(viewer.page)).toBeVisible();
    // The language picker is not usable for a viewer: four steps, none of them about it.
    await expect(viewer.page.getByTestId("tour-step")).toHaveText("1 / 4");
    await walkToDone(viewer.page);
    await expect(viewer.page.getByRole("dialog", { name: "Language" })).toHaveCount(0);
    await viewer.page.keyboard.press("Enter");
    await expect(tourDialog(viewer.page)).toBeHidden();
  } finally {
    await closeAll(owner, viewer);
  }
});

test("at 320px every step stays on screen and never covers what it points at", async ({
  browser,
}) => {
  const user = await firstTimer(browser, "Narrow", { viewport: { width: 320, height: 568 } });
  const { page } = user;
  try {
    await createShare(page);
    await answerDeviceQuestion(page);
    await expect(tourDialog(page)).toBeVisible();

    const total = Number((await counter(page)).split("/")[1]);
    expect(total).toBeGreaterThanOrEqual(4);
    const seen: string[] = [];
    for (let step = 1; step <= total; step++) {
      await expect(page.getByTestId("tour-step")).toHaveText(`${step} / ${total}`);
      await settle(page);
      const title = (await page.getByRole("dialog").getByRole("heading").textContent()) ?? "";
      seen.push(title);
      const box = await page.evaluate(() => {
        const rect = (selector: string) => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        return {
          tour: rect('[data-testid="tour"]'),
          spot: rect('[data-testid="tour-spot"]'),
          scrollWidth: document.documentElement.scrollWidth,
          width: innerWidth,
          height: innerHeight,
        };
      });
      const { tour, spot } = box;
      if (!tour || !spot) throw new Error(`step ${step}: missing popover or spotlight`);
      const label = `step ${step} (${title})`;
      // The popover is on screen, and the page did not grow sideways.
      expect(tour.left, label).toBeGreaterThanOrEqual(0);
      expect(tour.right, label).toBeLessThanOrEqual(box.width);
      expect(tour.top, label).toBeGreaterThanOrEqual(0);
      expect(tour.bottom, label).toBeLessThanOrEqual(box.height);
      expect(box.scrollWidth, label).toBeLessThanOrEqual(box.width);
      // So is the highlighted element, and the popover does not sit on it.
      expect(spot.left, label).toBeGreaterThanOrEqual(-1);
      expect(spot.right, label).toBeLessThanOrEqual(box.width + 1);
      const covers =
        tour.left < spot.right &&
        tour.right > spot.left &&
        tour.top < spot.bottom &&
        tour.bottom > spot.top;
      expect(covers, label).toBe(false);
      if (step < total) await page.keyboard.press("Enter");
    }
    // Five distinct places, in order.
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe("Invite others");
  } finally {
    await closeAll(user);
  }
});

test("light, dark and high contrast: the spotlight and popover stay readable", async ({
  browser,
}) => {
  for (const scheme of ["light", "dark"] as const) {
    const user = await firstTimer(browser, `Look${scheme}`, { colorScheme: scheme });
    const { page } = user;
    try {
      await createShare(page);
      await answerDeviceQuestion(page);
      await expect(tourDialog(page)).toBeVisible();
      await settle(page);
      const look = await page.evaluate(() => {
        const spot = getComputedStyle(
          document.querySelector('[data-testid="tour-spot"]') as Element,
        );
        const tour = getComputedStyle(document.querySelector('[data-testid="tour"]') as Element);
        return {
          outline: spot.outlineStyle,
          outlineWidth: Number.parseFloat(spot.outlineWidth),
          shadow: spot.boxShadow,
          background: tour.backgroundColor,
          color: tour.color,
        };
      });
      expect(look.outline).toBe("solid");
      expect(look.outlineWidth).toBeGreaterThanOrEqual(2);
      expect(look.shadow).not.toBe("none");
      expect(look.background).not.toBe(look.color);
      expect(look.background).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      await closeAll(user);
    }
  }

  const contrast = await firstTimer(browser, "Contrast", { contrast: "more" });
  try {
    await createShare(contrast.page);
    await answerDeviceQuestion(contrast.page);
    await expect(tourDialog(contrast.page)).toBeVisible();
    const width = await contrast.page
      .getByTestId("tour-spot")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth));
    expect(width).toBeGreaterThanOrEqual(3);
  } finally {
    await closeAll(contrast);
  }
});

test("reduced motion: the tour moves nothing, motion allowed: it glides on translate only", async ({
  browser,
}) => {
  const motion = await firstTimer(browser, "Glide", { reducedMotion: "no-preference" });
  const reduced = await firstTimer(browser, "Still", { reducedMotion: "reduce" });
  try {
    for (const user of [motion, reduced]) {
      await createShare(user.page);
      await answerDeviceQuestion(user.page);
      await expect(tourDialog(user.page)).toBeVisible();
      await settle(user.page);
    }
    const style = (page: Page) =>
      page.evaluate(() => {
        const pop = getComputedStyle(document.querySelector('[data-testid="tour"]') as Element);
        const spot = getComputedStyle(
          document.querySelector('[data-testid="tour-spot"]') as Element,
        );
        return {
          property: pop.transitionProperty,
          duration: Number.parseFloat(pop.transitionDuration),
          spotAnimation: spot.animationName,
          popAnimationDuration: Number.parseFloat(pop.animationDuration),
        };
      });
    const on = await style(motion.page);
    expect(on.property).toBe("translate");
    expect(on.duration).toBeGreaterThanOrEqual(0.1);
    expect(on.spotAnimation).toBe("tour-spot-in");

    const off = await style(reduced.page);
    expect(off.duration).toBeLessThan(0.001);
    expect(off.spotAnimation).toBe("none");
    expect(off.popAnimationDuration).toBeLessThan(0.001);

    // And a step change under reduced motion is an instant jump: nothing is left animating.
    await reduced.page.keyboard.press("Enter");
    await expect(reduced.page.getByTestId("tour-step")).toHaveText("2 / 5");
    await expect
      .poll(
        () =>
          reduced.page.evaluate(
            () => document.querySelector('[data-testid="tour"]')?.getAnimations().length,
          ),
        { timeout: 1000 },
      )
      .toBe(0);
  } finally {
    await closeAll(motion, reduced);
  }
});
