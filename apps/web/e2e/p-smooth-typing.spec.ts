import { expect, type Page, test } from "@playwright/test";
import {
  closeAll,
  createShare,
  editorText,
  joinByLink,
  newUser,
  type User,
  waitForEditor,
} from "./helpers";

/** Transition of the gliding cursor, or null when there is none. */
async function caretTransition(
  page: Page,
): Promise<{ property: string; duration: string; easing: string } | null> {
  return page.evaluate(() => {
    const caret = document.querySelector<HTMLElement>(".cm-smooth-caret");
    if (!caret) return null;
    const style = getComputedStyle(caret);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
      easing: style.transitionTimingFunction,
    };
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
    await owner.page.emulateMedia({ reducedMotion: "no-preference" });
    await createShare(owner.page);
    // The device question above the editor goes first: its layout must not move the editor
    // while the caret is measured.
    await owner.page.getByTestId("device-choice-skip").click();
    await expect(owner.page.getByTestId("device-choice")).toBeHidden();
    const editor = owner.page.locator(".cm-editor");
    await owner.page.locator(".cm-content").click();
    await expect(editor).toHaveClass(/cm-focused/);
    // Even the first move must restart from the CSS default animation name. Seek into the dark
    // portion first; checking immediately after input catches an accidental same-name restart.
    await owner.page.locator(".cm-smooth-caret-layer").evaluate(async (el) => {
      const blink = el.getAnimations()[0];
      if (!blink) throw new Error("missing smooth blink animation");
      await blink.ready;
      blink.currentTime = 960;
    });
    await owner.page.keyboard.type("l");
    await owner.page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(
      await owner.page
        .locator(".cm-smooth-caret-layer")
        .evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("1");
    await owner.page.keyboard.type("et a = 1;");

    // On by default: the editor says so, and the cursor moves with a transform transition.
    await expect(editor).toHaveAttribute("data-smooth-typing", "on");
    // A font arriving with the first glyphs moves the text, and that move snaps on purpose: let the
    // fonts settle, then read the placement drawn for one more keystroke.
    await owner.page.evaluate(() => document.fonts.ready.then(() => undefined));
    await owner.page.keyboard.type(" ");
    await owner.page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const on = await caretTransition(owner.page);
    expect(on?.property).toBe("transform");
    expect(Number.parseFloat(on?.duration ?? "0")).toBeGreaterThanOrEqual(0.08);
    expect(Number.parseFloat(on?.duration ?? "0")).toBeLessThanOrEqual(0.12);
    expect(on?.easing).toMatch(/^cubic-bezier\(/);
    const blink = await owner.page.locator(".cm-smooth-caret-layer").evaluate((el) => {
      const style = getComputedStyle(el);
      const animation = el.getAnimations()[0] as CSSAnimation | undefined;
      return {
        name: style.animationName,
        easing: style.animationTimingFunction,
        opacities: (animation?.effect as KeyframeEffect | null)
          ?.getKeyframes()
          .map((frame) => frame.opacity),
      };
    });
    expect(blink.name).toMatch(/^cm-smooth-blink/);
    expect(blink.easing).not.toContain("steps");
    expect(blink.opacities).toContain("0");
    expect(blink.opacities).toContain("1");
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
    await expect(owner.page.locator(".cm-smooth-caret-layer")).toHaveCSS("animation-name", "none");
    await expect(owner.page.locator(".cm-smooth-caret-layer")).toHaveCSS("opacity", "1");
    expect(await visibleMainCursors(owner.page)).toBe(1);
  } finally {
    await closeAll(owner);
  }
});

test("remote typing preserves the local blink and editor layers", async ({ browser }) => {
  const owner = await newUser(browser, "Local");
  const guest = await newUser(browser, "Remote");
  try {
    await owner.page.emulateMedia({ reducedMotion: "no-preference" });
    const id = await createShare(owner.page);
    await owner.page.getByTestId("device-choice-skip").click();
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("local ");
    await joinByLink(guest, id);
    await waitForEditor(guest.page);
    await guest.page.getByTestId("device-choice-skip").click();
    await guest.page.locator(".cm-content").click();
    await guest.page.keyboard.press("ControlOrMeta+Home");
    await owner.page.locator(".cm-content").focus();
    await expect(owner.page.locator(".cm-editor")).toHaveClass(/cm-focused/);
    await owner.page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>(".cm-smooth-caret-layer");
      if (!layer) throw new Error("missing caret layer");
      const probe = {
        editor: document.querySelector(".cm-editor"),
        caret: document.querySelector(".cm-smooth-caret"),
        layer,
        blink: layer.getAnimations()[0],
        name: layer.style.animationName + layer.style.getPropertyValue("--caret-blink"),
        restarts: 0,
      };
      new MutationObserver(() => {
        const name = layer.style.animationName + layer.style.getPropertyValue("--caret-blink");
        if (name !== probe.name) probe.restarts++;
        probe.name = name;
      }).observe(layer, { attributes: true, attributeFilter: ["style"] });
      (window as unknown as { __localCaret: typeof probe }).__localCaret = probe;
    });
    await guest.page.keyboard.type("remote updates keep arriving ", { delay: 90 });
    await expect.poll(() => editorText(owner.page)).toContain("remote updates keep arriving");
    const result = await owner.page.evaluate(() => {
      const probe = (
        window as unknown as {
          __localCaret: {
            editor: Element;
            caret: Element;
            layer: Element;
            blink: Animation;
            restarts: number;
          };
        }
      ).__localCaret;
      return {
        restarts: probe.restarts,
        editorKept: probe.editor === document.querySelector(".cm-editor"),
        caretKept: probe.caret === document.querySelector(".cm-smooth-caret"),
        blinkKept: probe.blink === probe.layer.getAnimations()[0],
        transition: (probe.caret as HTMLElement).style.transition,
      };
    });
    expect(result).toEqual({
      restarts: 0,
      editorKept: true,
      caretKept: true,
      blinkKept: true,
      transition: "none",
    });
  } finally {
    await closeAll(owner, guest);
  }
});

test("typing, deletion and nearby keyboard moves glide on the same caret; jumps snap", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Moves");
  try {
    const page = owner.page;
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await createShare(page);
    await page.getByTestId("device-choice-skip").click();
    await page.locator(".cm-content").click();
    await page.keyboard.type("first line\nsecond line\nthird line\nfourth line\nfifth line");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const probe = { caret: document.querySelector(".cm-smooth-caret"), runs: 0 };
      document.addEventListener("transitionrun", (event) => {
        if (event.target === probe.caret && event.propertyName === "transform") probe.runs++;
      });
      (window as unknown as { __motion: typeof probe }).__motion = probe;
    });
    const runs = () =>
      page.evaluate(() => (window as unknown as { __motion: { runs: number } }).__motion.runs);
    for (const key of [
      "x",
      "Backspace",
      "ArrowLeft",
      "Delete",
      "Home",
      "End",
      "ArrowUp",
      "ArrowDown",
    ]) {
      const before = await runs();
      await page.keyboard.press(key);
      if (key === "Delete") {
        // Forward delete usually leaves the caret in place; WebKit can adjust glyph coordinates
        // slightly. Either way, keep the DOM and allow a transform transition when it does move.
        await expect.poll(async () => (await caretTransition(page))?.property).toBe("transform");
      } else {
        await expect
          .poll(runs, { message: `${key} starts a transform transition` })
          .toBeGreaterThan(before);
      }
      await page.waitForTimeout(130);
    }
    const beforeJump = await runs();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.waitForTimeout(130);
    expect(await runs()).toBe(beforeJump);
    expect(
      await page.locator(".cm-smooth-caret").evaluate((el) => (el as HTMLElement).style.transition),
    ).toBe("none");
    await page.locator(".cm-line").nth(2).click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "pasted text");
      document
        .querySelector(".cm-content")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(130);
    expect(await runs()).toBe(beforeJump);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __motion: { caret: Element } }).__motion.caret ===
          document.querySelector(".cm-smooth-caret"),
      ),
    ).toBe(true);
  } finally {
    await closeAll(owner);
  }
});

/**
 * Drives a real IME composition through Chromium's CDP and counts the transform transitions the
 * gliding cursor starts. Each step settles first, so a glide finished or snapped is counted once.
 */
async function imeSession(owner: User) {
  const page = owner.page;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await createShare(page);
  await page.getByTestId("device-choice-skip").click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => {
    const w = window as unknown as { __glides: number };
    w.__glides = 0;
    document.addEventListener("transitionrun", (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains("cm-smooth-caret") && event.propertyName === "transform") {
        w.__glides++;
      }
    });
  });
  const cdp = await owner.context.newCDPSession(page);
  const settle = () => page.waitForTimeout(150);
  return {
    glides: () => page.evaluate(() => (window as unknown as { __glides: number }).__glides),
    async compose(text: string) {
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await settle();
    },
    async commit(text: string) {
      await page.keyboard.insertText(text);
      await settle();
    },
    // Where the cursor settles compared with CodeMirror's own (hidden) cursor.
    offset: () =>
      page.evaluate(() => {
        const caret = document.querySelector(".cm-smooth-caret") as HTMLElement;
        const native = document.querySelector(".cm-cursor-primary") as HTMLElement;
        const a = caret.getBoundingClientRect();
        const b = native.getBoundingClientRect();
        return Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));
      }),
  };
}

test("a Hangul composition glides to the next syllable and stays put inside one", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Hangul");
  try {
    const ime = await imeSession(owner);
    const page = owner.page;
    // The first jamo moves the cursor on to a new place, so it glides; the jamo that join it into
    // a syllable only change its width, so they snap and start nothing.
    await ime.compose("ㅎ");
    const first = await ime.glides();
    expect(first).toBeGreaterThan(0);
    for (const step of ["하", "한"]) {
      await ime.compose(step);
      expect(await visibleMainCursors(page)).toBe(1);
      expect(await ime.offset()).toBeLessThan(1.5);
    }
    expect(await ime.glides()).toBe(first);
    await ime.commit("한");
    expect(await ime.glides()).toBe(first);
    // The next syllable moves the cursor on again: another glide, to where the text ends.
    await ime.compose("ㄱ");
    const second = await ime.glides();
    expect(second).toBeGreaterThan(first);
    expect(await ime.offset()).toBeLessThan(1.5);
    await ime.compose("그");
    await ime.compose("글");
    await ime.commit("글");
    await expect(page.locator(".cm-content")).toContainText("한글");
    expect(await visibleMainCursors(page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    expect(await ime.glides()).toBe(second);
    // Ordinary typing afterwards glides as before.
    await page.keyboard.type("x");
    await expect.poll(ime.glides).toBeGreaterThan(second);
  } finally {
    await closeAll(owner);
  }
});

test("a Japanese composition, with its candidate window, still snaps", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Kana");
  try {
    const ime = await imeSession(owner);
    for (const step of ["か", "かん", "かんじ"]) {
      await ime.compose(step);
      expect(await visibleMainCursors(owner.page)).toBe(1);
      expect(await ime.offset()).toBeLessThan(1.5);
    }
    await ime.commit("漢字");
    await ime.compose("さ");
    await expect(owner.page.locator(".cm-content")).toContainText("漢字さ");
    expect(await ime.offset()).toBeLessThan(1.5);
    expect(await ime.glides()).toBe(0);
    await ime.commit("さ");
    expect(await ime.glides()).toBe(0);
    await owner.page.keyboard.type("x");
    await expect.poll(ime.glides).toBeGreaterThan(0);
  } finally {
    await closeAll(owner);
  }
});

test("vim mode keeps its own cursor with smooth typing on", async ({ browser }) => {
  const owner = await newUser(browser, "Vim");
  try {
    await owner.context.addInitScript(() =>
      localStorage.setItem("gachipad.prefs", JSON.stringify({ keymap: "vim" })),
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
