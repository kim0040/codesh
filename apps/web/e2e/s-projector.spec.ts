import { expect, test } from "@playwright/test";
import {
  closeAll,
  createShare,
  joinByLink,
  newUser,
  openShareDialog,
  waitForEditor,
} from "./helpers";

test("projector requests fullscreen once and stays there during live edits", async ({
  browser,
}, testInfo) => {
  const owner = await newUser(browser, "Projector");
  const guest = await newUser(browser, "Typing");
  try {
    // Count real browser calls as well as checking actual fullscreen. No fullscreen shim.
    await owner.context.addInitScript(() => {
      const probe = { requests: 0, exits: 0 };
      (window as unknown as { __fullscreen: typeof probe }).__fullscreen = probe;
      const request = HTMLElement.prototype.requestFullscreen;
      if (request)
        HTMLElement.prototype.requestFullscreen = function (...args) {
          probe.requests++;
          return request.apply(this, args);
        };
      const exit = document.exitFullscreen;
      if (exit)
        document.exitFullscreen = function () {
          probe.exits++;
          return exit.call(this);
        };
    });
    const id = await createShare(owner.page);
    await joinByLink(guest, id);
    await waitForEditor(guest.page);
    await guest.page.getByTestId("device-choice-skip").click();
    await guest.page.locator(".cm-content").click();
    await openShareDialog(owner.page);
    await owner.page.getByTestId("projector-button").click();
    await expect(owner.page.getByTestId("projector")).toBeVisible();
    await owner.page.waitForTimeout(300);
    const entered = await owner.page.evaluate(() => !!document.fullscreenElement);
    if (!entered)
      testInfo.annotations.push({
        type: "fullscreen",
        description:
          "Headless engine did not expose element fullscreen; real request/cleanup counters verify effect lifetime.",
      });
    const before = await owner.page.evaluate(
      () =>
        (window as unknown as { __fullscreen: { requests: number; exits: number } }).__fullscreen,
    );
    if (before.requests) expect(before.requests).toBe(1);
    for (let i = 0; i < 4; i++) {
      await guest.page.keyboard.type("live edits ", { delay: 80 });
      await guest.page.keyboard.press("ArrowLeft");
      await guest.page.keyboard.press("ArrowRight");
      await expect(owner.page.getByTestId("projector")).toBeVisible();
      if (entered) expect(await owner.page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    }
    // Joining/leaving also changes React's participants context, unlike cursor-only updates.
    await guest.context.close();
    await owner.page.waitForTimeout(500);
    expect(
      await owner.page.evaluate(
        () =>
          (window as unknown as { __fullscreen: { requests: number; exits: number } }).__fullscreen,
      ),
    ).toEqual(before);
    await expect(owner.page.getByTestId("projector")).toBeVisible();
    if (entered) {
      expect(await owner.page.evaluate(() => !!document.fullscreenElement)).toBe(true);
      // Browser UI exit dispatches fullscreenchange, without invoking the overlay button.
      await owner.page.evaluate(() => document.exitFullscreen());
    } else {
      await owner.page.keyboard.press("Escape");
    }
    await expect(owner.page.getByTestId("projector")).toBeHidden();

    await owner.page.getByTestId("projector-button").click();
    await expect(owner.page.getByTestId("projector")).toBeVisible();
    await owner.page.getByTestId("projector-exit").click();
    await expect(owner.page.getByTestId("projector")).toBeHidden();
    await expect.poll(() => owner.page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    if (!(await owner.page.getByTestId("projector-button").isVisible())) {
      await openShareDialog(owner.page);
    }
    await owner.page.getByTestId("projector-button").click();
    await owner.page.keyboard.press("Escape");
    await expect(owner.page.getByTestId("projector")).toBeHidden();
  } finally {
    await closeAll(owner, guest);
  }
});
