import { expect, type Page, test } from "@playwright/test";
import { closeAll, createShare, newUser } from "./helpers";

/** Transition of the gliding cursor, or null when there is none. */
async function caretTransition(page: Page): Promise<{ property: string; duration: string } | null> {
  return page.evaluate(() => {
    const caret = document.querySelector<HTMLElement>(".cm-smooth-caret");
    if (!caret) return null;
    const style = getComputedStyle(caret);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
}

/** The visible main cursors: exactly one, whichever layer draws it. */
async function visibleMainCursors(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>(".cm-smooth-caret, .cm-cursor-primary")].filter(
        (el) => {
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        },
      ).length,
  );
}

test("smooth typing glides the cursor and the setting turns it off", async ({ browser }) => {
  const owner = await newUser(browser, "Glide");
  try {
    await createShare(owner.page);
    const editor = owner.page.locator(".cm-editor");
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("let a = 1;");

    // On by default: the editor says so, and the cursor moves with a transform transition.
    await expect(editor).toHaveAttribute("data-smooth-typing", "on");
    const on = await caretTransition(owner.page);
    expect(on?.property).toBe("transform");
    expect(Number.parseFloat(on?.duration ?? "0")).toBeGreaterThan(0);
    expect(await visibleMainCursors(owner.page)).toBe(1);
    // CodeMirror's layer still holds one cursor per selection; the gliding one is not counted there.
    await expect(owner.page.locator(".cm-cursorLayer .cm-cursor")).toHaveCount(1);
    // It sits where CodeMirror would draw the cursor.
    const [glided, native] = await owner.page.evaluate(() => {
      const caret = document.querySelector(".cm-smooth-caret") as HTMLElement;
      caret.style.transition = "none";
      const native = document.querySelector(".cm-cursor-primary") as HTMLElement;
      return [caret.getBoundingClientRect().left, native.getBoundingClientRect().left];
    });
    expect(Math.abs(glided - native)).toBeLessThan(1.5);

    // Off in the settings: CodeMirror's own cursor, no transition, and it stays off after a reload.
    await owner.page.getByTestId("settings-button").click();
    const toggle = owner.page.getByTestId("switch-smooth-typing");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await owner.page.keyboard.press("Escape");
    await expect(editor).not.toHaveAttribute("data-smooth-typing");
    expect(await caretTransition(owner.page)).toBeNull();
    await owner.page.reload();
    await expect(owner.page.locator(".cm-content")).toBeVisible();
    await expect(owner.page.locator(".cm-editor")).not.toHaveAttribute("data-smooth-typing");
  } finally {
    await closeAll(owner);
  }
});

test("smooth typing has no animation under reduced motion", async ({ browser }) => {
  const owner = await newUser(browser, "Still");
  try {
    await owner.page.emulateMedia({ reducedMotion: "reduce" });
    await createShare(owner.page);
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("x");
    await expect(owner.page.locator(".cm-editor")).toHaveAttribute("data-smooth-typing", "on");
    const still = await caretTransition(owner.page);
    // editor.css drops the transition; the app's reduced-motion reset also cuts every duration.
    expect(still?.property ?? "none").toBe("none");
    expect(await visibleMainCursors(owner.page)).toBe(1);
  } finally {
    await closeAll(owner);
  }
});

test("a Hangul composition shows one cursor, where the text ends", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Hangul");
  try {
    await createShare(owner.page);
    const page = owner.page;
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    const cdp = await owner.context.newCDPSession(page);
    const compose = (text: string) =>
      cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    // Where the glide ends compared with CodeMirror's own (hidden) cursor, once it settles.
    const offset = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const caret = document.querySelector(".cm-smooth-caret") as HTMLElement;
        const native = document.querySelector(".cm-cursor-primary") as HTMLElement;
        const a = caret.getBoundingClientRect();
        const b = native.getBoundingClientRect();
        return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));
      });

    for (const step of ["ㅎ", "하", "한"]) {
      await compose(step);
      expect(await visibleMainCursors(page)).toBe(1);
      expect(await offset()).toBeLessThan(1.5);
    }
    await page.keyboard.insertText("한");
    await compose("ㄱ");
    await compose("그");
    await compose("글");
    await page.keyboard.insertText("글");
    await expect(page.locator(".cm-content")).toContainText("한글");
    expect(await visibleMainCursors(page)).toBe(1);
    expect(await offset()).toBeLessThan(1.5);
  } finally {
    await closeAll(owner);
  }
});

test("vim mode keeps its own cursor with smooth typing on", async ({ browser }) => {
  const owner = await newUser(browser, "Vim");
  try {
    await owner.context.addInitScript(() =>
      localStorage.setItem("codesh.prefs", JSON.stringify({ keymap: "vim" })),
    );
    await createShare(owner.page);
    await owner.page.locator(".cm-content").click();
    await expect(owner.page.locator(".cm-editor")).toHaveAttribute("data-smooth-typing", "on");
    // The block cursor of normal mode shows; the gliding cursor is hidden like CodeMirror's.
    await expect(owner.page.locator(".cm-fat-cursor").first()).toBeVisible();
    await expect(owner.page.locator(".cm-smooth-caret")).toBeHidden();
  } finally {
    await closeAll(owner);
  }
});
