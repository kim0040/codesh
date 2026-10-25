import { expect, test } from "@playwright/test";
import { closeAll, createShare, editorText, joinByLink, newUser, waitForEditor } from "./helpers";

test("remote caret identity survives selection changes and another participant leaving", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Watching");
  const guests = [await newUser(browser, "First"), await newUser(browser, "Second")];
  try {
    // Session colors are random and may collide; tint identity needs two distinct colors.
    for (const [i, guest] of guests.entries()) {
      const response = await guest.context.request.patch("/api/session", {
        data: { color: i === 0 ? "#2563eb" : "#b45309" },
      });
      expect(response.ok()).toBe(true);
    }
    await owner.page.emulateMedia({ reducedMotion: "no-preference" });
    const id = await createShare(owner.page);
    await owner.page.getByTestId("device-choice-skip").click();
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("a shared line of text");
    for (const guest of guests) {
      await joinByLink(guest, id);
      await waitForEditor(guest.page);
      await guest.page.getByTestId("device-choice-skip").click();
      await guest.page.locator(".cm-content").click();
      await guest.page.keyboard.press("End");
    }
    const carets = owner.page.locator(".cm-remote-caret");
    await expect(carets).toHaveCount(2);
    const names = await carets.locator(".cm-remote-caret-flag").allTextContents();
    const leaving = guests.find((guest) => guest.name === names[0]);
    const staying = guests.find((guest) => guest.name === names[1]);
    if (!leaving || !staying) throw new Error("missing participants");
    await owner.page.evaluate((name) => {
      const caret = [...document.querySelectorAll(".cm-remote-caret")].find(
        (el) => el.textContent === name,
      );
      if (!caret) throw new Error("missing remote caret");
      const probe = { caret, flag: caret.lastElementChild, removed: 0 };
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes) {
            if (node === caret || (node instanceof Element && node.contains(caret)))
              probe.removed++;
          }
      }).observe(document.querySelector(".cm-remote-carets") as Element, {
        childList: true,
        subtree: true,
      });
      (window as unknown as { __remoteCaret: typeof probe }).__remoteCaret = probe;
    }, staying.name);
    for (let i = 0; i < 3; i++) {
      await staying.page.keyboard.press("Shift+ArrowLeft");
      await expect(owner.page.locator(".cm-remote-selection")).not.toHaveCount(0);
      await staying.page.keyboard.press("ArrowRight");
      await expect(owner.page.locator(".cm-remote-selection")).toHaveCount(0);
    }
    await leaving.page.keyboard.press("Shift+ArrowLeft");
    await staying.page.keyboard.press("Shift+ArrowLeft");
    await expect(owner.page.locator(".cm-remote-selection")).toHaveCount(2);
    await owner.page.evaluate((name) => {
      const caret = [...document.querySelectorAll<HTMLElement>(".cm-remote-caret")].find(
        (el) => el.textContent === name,
      );
      const color = caret?.style.getPropertyValue("--rc");
      const tint = [...document.querySelectorAll<HTMLElement>(".cm-remote-selection")].find(
        (el) => el.style.getPropertyValue("--rc") === color,
      );
      (window as unknown as { __tint: Element | undefined }).__tint = tint;
    }, staying.name);
    await leaving.page.keyboard.press("ArrowRight");
    await expect(owner.page.locator(".cm-remote-selection")).toHaveCount(1);
    expect(
      await owner.page.evaluate(
        () =>
          (window as unknown as { __tint: Element }).__tint ===
          document.querySelector(".cm-remote-selection"),
      ),
    ).toBe(true);
    await staying.page.keyboard.press("ArrowRight");
    await staying.page.keyboard.type(" continuous typing ", { delay: 90 });
    await expect.poll(() => editorText(owner.page)).toContain("continuous typing");
    const activeFlag = carets.filter({ hasText: staying.name }).locator(".cm-remote-caret-flag");
    await expect(activeFlag).toHaveCSS("opacity", "1");
    // A move during the idle fade keeps the flag visible instead of fading from zero again.
    await owner.page.waitForTimeout(2450);
    await staying.page.keyboard.press("ArrowLeft");
    await expect(carets.filter({ hasText: staying.name })).toHaveAttribute(
      "data-flag-from",
      "shown",
    );
    await staying.page.keyboard.press("ArrowRight");
    await leaving.context.close();
    await expect(carets).toHaveCount(1);
    await staying.page.keyboard.type("still typing", { delay: 90 });
    await expect.poll(() => editorText(owner.page)).toContain("still typing");
    expect(
      await owner.page.evaluate(() => {
        const probe = (
          window as unknown as { __remoteCaret: { caret: Element; flag: Element; removed: number } }
        ).__remoteCaret;
        return {
          removed: probe.removed,
          sameCaret: probe.caret === document.querySelector(".cm-remote-caret"),
          sameFlag: probe.flag === document.querySelector(".cm-remote-caret-flag"),
        };
      }),
    ).toEqual({ removed: 0, sameCaret: true, sameFlag: true });
  } finally {
    await closeAll(owner, ...guests);
  }
});
