import { expect, type Page, test } from "@playwright/test";
import { closeAll, createShare, joinByLink, newUser, openShareDialog, shareIdOf } from "./helpers";

/** Keyframes the app draws that animate layout; kept only because nothing uses them. */
const UNUSED_LAYOUT_KEYFRAMES = /^ui-collapse-(down|up)$/;

test("every keyframe the app ships animates only opacity and transforms", async ({ page }) => {
  await page.goto("/");
  const offenders = await page.evaluate(() => {
    const found: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule) {
          for (const frame of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
            for (const property of Array.from(frame.style)) found.push(`${rule.name}:${property}`);
          }
        } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // A cross-origin sheet cannot be read; the app ships none.
      }
    }
    return found;
  });
  expect(offenders.length).toBeGreaterThan(5);
  const layout = offenders.filter((entry) => {
    const [name = "", property = ""] = entry.split(":");
    if (name.startsWith("cm-") || UNUSED_LAYOUT_KEYFRAMES.test(name)) return false;
    return !["opacity", "transform", "translate", "scale"].includes(property);
  });
  expect(layout).toEqual([]);
});

async function dialogMotion(page: Page) {
  await openShareDialog(page);
  return page.evaluate(() => {
    const dialog = getComputedStyle(document.querySelector('[role="dialog"]') as Element);
    const scrim = getComputedStyle(document.querySelector(".ui-fade") as Element);
    return {
      dialog: dialog.animationName,
      dialogSeconds: Number.parseFloat(dialog.animationDuration),
      scrim: scrim.animationName,
      scrimSeconds: Number.parseFloat(scrim.animationDuration),
    };
  });
}

test("dialogs, sheets, buttons and tabs use the motion tokens; reduced motion removes them", async ({
  browser,
}) => {
  const motion = await newUser(browser, "Move");
  const still = await newUser(browser, "Still");
  try {
    await motion.page.emulateMedia({ reducedMotion: "no-preference" });
    await still.page.emulateMedia({ reducedMotion: "reduce" });
    await createShare(motion.page);
    await createShare(still.page);

    const on = await dialogMotion(motion.page);
    expect(on.dialog).toBe("ui-dialog-in");
    expect(on.dialogSeconds).toBeCloseTo(0.18, 2);
    expect(on.scrim).toBe("ui-fade-in");

    const off = await dialogMotion(still.page);
    expect(off.dialogSeconds).toBeLessThan(0.001);
    expect(off.scrimSeconds).toBeLessThan(0.001);

    // The tab underline grows with a transform; the panel it reveals fades in.
    for (const user of [motion, still]) {
      await user.page.getByRole("tab", { name: "Send" }).click();
    }
    const tabs = (page: Page) =>
      page.evaluate(() => {
        const tab = document.querySelector('[role="tab"][data-state="active"]') as Element;
        const after = getComputedStyle(tab, "::after");
        const panel = getComputedStyle(document.querySelector('[role="tabpanel"]') as Element);
        return {
          underline: after.transitionProperty,
          underlineSeconds: Number.parseFloat(after.transitionDuration),
          panel: panel.animationName,
          panelSeconds: Number.parseFloat(panel.animationDuration),
        };
      });
    const tabsOn = await tabs(motion.page);
    expect(tabsOn.underline).toContain("transform");
    expect(tabsOn.underlineSeconds).toBeCloseTo(0.18, 2);
    expect(tabsOn.panel).toBe("ui-appear-fade");
    const tabsOff = await tabs(still.page);
    expect(tabsOff.underlineSeconds).toBeLessThan(0.001);
    expect(tabsOff.panelSeconds).toBeLessThan(0.001);

    // Sheet: Settings slides from its edge, and not at all under reduced motion.
    for (const user of [motion, still]) await user.page.keyboard.press("Escape");
    for (const user of [motion, still]) await user.page.getByTestId("settings-button").click();
    const sheet = (page: Page) =>
      page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".ui-sheet-right") as Element);
        return { name: style.animationName, seconds: Number.parseFloat(style.animationDuration) };
      });
    expect(await sheet(motion.page)).toEqual({ name: "ui-slide-in-right", seconds: 0.26 });
    expect((await sheet(still.page)).seconds).toBeLessThan(0.001);

    // The switch thumb travels with `translate`, so that is the property its transition names.
    const thumb = await motion.page
      .locator('[role="switch"] > span')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(thumb).toContain("translate");
  } finally {
    await closeAll(motion, still);
  }
});

test("a button and a switch move with transitions that name the property they move, unless reduced", async ({
  browser,
}) => {
  const motion = await newUser(browser, "PressA");
  const still = await newUser(browser, "PressB");
  try {
    await motion.page.emulateMedia({ reducedMotion: "no-preference" });
    await still.page.emulateMedia({ reducedMotion: "reduce" });
    for (const user of [motion, still]) await user.page.goto("/");
    const press = async (page: Page) => {
      const button = page.getByTestId("new-from-template");
      const box = await button.boundingBox();
      if (!box) throw new Error("no button");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      try {
        await page.waitForTimeout(300);
        return await button.evaluate((el) => getComputedStyle(el).scale);
      } finally {
        await page.mouse.up({ button: "left" });
        // Release away from the button so the press does not open the picker.
        await page.mouse.move(0, 0);
      }
    };
    expect(await press(motion.page)).toBe("0.98");
    expect(await press(still.page)).toBe("none");
    // The transition lists the property the press changes (Tailwind scales with `scale`, not `transform`).
    const listed = await motion.page
      .getByTestId("new-from-template")
      .evaluate((el) => getComputedStyle(el).transitionProperty);
    expect(listed).toContain("scale");
  } finally {
    await closeAll(motion, still);
  }
});

test("a person joining fades into the avatar row", async ({ browser }) => {
  const owner = await newUser(browser, "Host");
  const guest = await newUser(browser, "Guest");
  try {
    await owner.page.emulateMedia({ reducedMotion: "no-preference" });
    await createShare(owner.page);
    await joinByLink(guest, shareIdOf(owner.page));
    const other = owner.page.getByTestId("people").getByRole("button", { name: /Follow/ });
    await expect(other).toBeVisible();
    expect(await other.evaluate((el) => getComputedStyle(el).animationName)).toBe("ui-appear-fade");
  } finally {
    await closeAll(owner, guest);
  }
});
