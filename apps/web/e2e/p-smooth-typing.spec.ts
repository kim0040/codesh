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

/** The editor's text and the browser's selection inside it, as offsets into that text. */
type EditorState = { text: string; start: number; end: number };

/**
 * Drives a real IME composition through Chromium's CDP and counts the transform transitions the
 * gliding cursor starts. `compose` and `commit` settle first, so a glide finished or snapped is
 * counted once; `send` does not, for steps that must arrive while the previous glide still runs.
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
    const w = window as unknown as { __glides: number; __log: [string, number][] };
    w.__glides = 0;
    w.__log = [];
    const note = (name: string) => w.__log.push([name, performance.now()]);
    document.addEventListener("compositionupdate", () => note("update"));
    document.addEventListener("transitionrun", (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains("cm-smooth-caret") && event.propertyName === "transform") {
        w.__glides++;
        note("run");
      }
    });
    document.addEventListener("transitioncancel", (event) => {
      if ((event.target as HTMLElement).classList.contains("cm-smooth-caret")) note("cancel");
    });
    document.addEventListener("transitionend", (event) => {
      if ((event.target as HTMLElement).classList.contains("cm-smooth-caret")) note("end");
    });
  });
  const cdp = await owner.context.newCDPSession(page);
  const settle = () => page.waitForTimeout(150);
  const state = (): Promise<EditorState> =>
    page.evaluate(() => {
      const content = document.querySelector(".cm-content") as HTMLElement;
      const selection = getSelection();
      const at = (node: Node | null, offset: number) => {
        if (!node || !content.contains(node)) return -1;
        const range = document.createRange();
        range.setStart(content, 0);
        range.setEnd(node, offset);
        return range.toString().length;
      };
      return {
        text: content.textContent ?? "",
        start: at(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0),
        end: at(selection?.focusNode ?? null, selection?.focusOffset ?? 0),
      };
    });
  const send = (text: string) =>
    cdp.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  return {
    glides: () => page.evaluate(() => (window as unknown as { __glides: number }).__glides),
    log: () =>
      page.evaluate(() => (window as unknown as { __log: [string, number][] }).__log.slice()),
    state,
    send,
    // The editor text and the cursor right after a step, each one checked.
    async compose(text: string, expected: { text: string; caret: number }) {
      await send(text);
      await settle();
      expect(await state()).toEqual({
        text: expected.text,
        start: expected.caret,
        end: expected.caret,
      });
    },
    async commit(text: string, expected: { text: string; caret: number }) {
      await page.keyboard.insertText(text);
      await settle();
      expect(await state()).toEqual({
        text: expected.text,
        start: expected.caret,
        end: expected.caret,
      });
    },
    // The cursor as drawn after the next two frames (well inside one glide): its inline
    // transition, running transitions, transform and height.
    caret: () =>
      page.evaluate(async () => {
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const caret = document.querySelector(".cm-smooth-caret") as HTMLElement;
        return {
          transition: caret.style.transition,
          running: caret.getAnimations().length,
          transform: caret.style.transform,
          height: caret.style.height,
        };
      }),
    // Where the cursor settles compared with CodeMirror's own (hidden) cursor.
    offset: () =>
      page.evaluate(() => {
        const caret = document.querySelector(".cm-smooth-caret") as HTMLElement;
        const native = document.querySelector(".cm-cursor-primary") as HTMLElement;
        const a = caret.getBoundingClientRect();
        const b = native.getBoundingClientRect();
        return Math.max(
          Math.abs(a.left - b.left),
          Math.abs(a.top - b.top),
          Math.abs(a.height - b.height),
        );
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
    await ime.compose("ㅎ", { text: "ㅎ", caret: 1 });
    const first = await ime.glides();
    expect(first).toBeGreaterThan(0);
    await ime.compose("하", { text: "하", caret: 1 });
    expect(await visibleMainCursors(page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    await ime.compose("한", { text: "한", caret: 1 });
    expect(await visibleMainCursors(page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    expect(await ime.glides()).toBe(first);
    await ime.commit("한", { text: "한", caret: 1 });
    expect(await ime.glides()).toBe(first);
    // The next syllable moves the cursor on again: another glide, to where the text ends.
    await ime.compose("ㄱ", { text: "한ㄱ", caret: 2 });
    const second = await ime.glides();
    expect(second).toBeGreaterThan(first);
    expect(await ime.offset()).toBeLessThan(1.5);
    await ime.compose("그", { text: "한그", caret: 2 });
    await ime.compose("글", { text: "한글", caret: 2 });
    await ime.commit("글", { text: "한글", caret: 2 });
    expect(await visibleMainCursors(page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    expect(await ime.glides()).toBe(second);
    // Ordinary typing afterwards glides as before.
    await page.keyboard.type("x");
    await expect.poll(ime.glides).toBeGreaterThan(second);
    expect((await ime.state()).text).toBe("한글x");
  } finally {
    await closeAll(owner);
  }
});

test("decomposed Hangul jamo glide per syllable, not per jamo", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Jamo");
  try {
    const ime = await imeSession(owner);
    const [h, a, n, s] = ["ᄒ", "ᅡ", "ᆫ", "ᄉ"];
    await ime.compose(h, { text: h, caret: 1 });
    const first = await ime.glides();
    expect(first).toBeGreaterThan(0);
    // The cursor moves with every jamo, but the syllable is the same one.
    await ime.compose(h + a, { text: h + a, caret: 2 });
    await ime.compose(h + a + n, { text: h + a + n, caret: 3 });
    expect(await ime.glides()).toBe(first);
    await ime.commit(h + a + n, { text: h + a + n, caret: 3 });
    expect(await ime.glides()).toBe(first);
    // The next syllable starts: a glide again.
    await ime.compose(s, { text: h + a + n + s, caret: 4 });
    expect(await ime.glides()).toBeGreaterThan(first);
    expect(await ime.offset()).toBeLessThan(1.5);
  } finally {
    await closeAll(owner);
  }
});

test("a Hangul step that arrives during the previous glide still lands exactly", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Overlap");
  try {
    const ime = await imeSession(owner);
    await ime.compose("한", { text: "한", caret: 1 });
    await ime.commit("한", { text: "한", caret: 1 });
    const before = await ime.glides();
    // The new syllable glides; the next step follows at once, with no settling in between.
    await ime.send("ㄱ");
    await expect.poll(ime.glides, { intervals: [5] }).toBeGreaterThan(before);
    await ime.send("그");
    // The snap cut the running glide short: nothing is left moving, and the cursor is where the
    // text ends right away, not after the old animation would have finished.
    expect(await ime.caret()).toMatchObject({ transition: "none", running: 0 });
    expect(await ime.state()).toEqual({ text: "한그", start: 2, end: 2 });
    expect(await ime.offset()).toBeLessThan(1.5);
    // The log shows the steps overlapped: the second update came less than one glide after the first run.
    const log = await ime.log();
    const run = log.filter(([name]) => name === "run").at(-1);
    const updates = log.filter(([name]) => name === "update");
    expect(run).toBeDefined();
    expect((updates.at(-1)?.[1] ?? Number.POSITIVE_INFINITY) - (run?.[1] ?? 0)).toBeLessThan(100);
    await ime.send("글");
    await owner.page.keyboard.insertText("글");
    await owner.page.waitForTimeout(150);
    expect(await ime.state()).toEqual({ text: "한글", start: 2, end: 2 });
    expect(await ime.offset()).toBeLessThan(1.5);
  } finally {
    await closeAll(owner);
  }
});

/**
 * Stands in for the browser reporting the composing text late. Range rects are the measure source
 * of the caret layer; `zero` makes them empty in height, `freeze` makes every one repeat the
 * last rects measured before it was switched on.
 */
async function stubMeasure(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __measure: { mode: string; last: DOMRect[] } };
    w.__measure = { mode: "live", last: [] };
    const original = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
      const live = Array.from(original.call(this));
      if (w.__measure.mode === "zero") {
        return live.map((r) => new DOMRect(r.x, r.y, r.width, 0)) as unknown as DOMRectList;
      }
      if (w.__measure.mode === "freeze") return w.__measure.last as unknown as DOMRectList;
      w.__measure.last = live;
      return live as unknown as DOMRectList;
    };
  });
  return (mode: "live" | "zero" | "freeze") =>
    page.evaluate((next) => {
      (window as unknown as { __measure: { mode: string } }).__measure.mode = next;
    }, mode);
}

test("a stale or empty measure of the composing text snaps at once", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Stale");
  try {
    const ime = await imeSession(owner);
    const page = owner.page;
    // A glide long enough to still be running when the next step arrives.
    await page.addStyleTag({
      content: ".cm-smooth-caret { transition-duration: 800ms !important; }",
    });
    const measure = await stubMeasure(page);
    await ime.compose("한", { text: "한", caret: 1 });
    await ime.commit("한", { text: "한", caret: 1 });
    await page.waitForTimeout(900);

    // 1. A rect without height: no glide to it, the cursor drawn at once.
    await measure("zero");
    const empty = await ime.glides();
    await ime.send("ㄱ");
    expect(await ime.caret()).toMatchObject({ transition: "none", running: 0, height: "0px" });
    expect(await ime.glides()).toBe(empty);
    // The corrected measure that follows snaps too, and lands where the text ends.
    await measure("live");
    await ime.send("가");
    expect((await ime.caret()).transition).toBe("none");
    expect(await ime.state()).toEqual({ text: "한가", start: 2, end: 2 });
    await page.waitForTimeout(900);
    expect(await ime.offset()).toBeLessThan(1.5);

    // 2. A step that would glide while the previous one is still gliding, measured at the same
    // spot: the glide stops at once instead of running on to the stale target.
    await ime.send("가ㄴ");
    await expect.poll(ime.glides, { intervals: [5] }).toBeGreaterThan(empty);
    const gliding = await ime.caret();
    expect(gliding.running).toBeGreaterThan(0);
    await measure("freeze");
    await ime.send("가나ㅅ");
    expect(await ime.caret()).toMatchObject({ transition: "none", running: 0 });
    // The stale measure was drawn as measured; the next, live one corrects it without a glide.
    expect((await ime.caret()).transform).toBe(gliding.transform);
    await measure("live");
    await ime.send("가나사");
    expect((await ime.caret()).transition).toBe("none");
    await page.waitForTimeout(900);
    expect(await ime.state()).toEqual({ text: "한가나사", start: 4, end: 4 });
    expect(await ime.offset()).toBeLessThan(1.5);
  } finally {
    await closeAll(owner);
  }
});

test("a Chinese composition and its candidate replacement snap", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Hanzi");
  try {
    const ime = await imeSession(owner);
    await ime.compose("n", { text: "n", caret: 1 });
    await ime.compose("ni", { text: "ni", caret: 2 });
    // The candidate picked from the window replaces the pinyin, then commits.
    await ime.compose("你", { text: "你", caret: 1 });
    await ime.commit("你", { text: "你", caret: 1 });
    await ime.compose("h", { text: "你h", caret: 2 });
    await ime.compose("hao", { text: "你hao", caret: 4 });
    await ime.compose("好", { text: "你好", caret: 2 });
    await ime.commit("好", { text: "你好", caret: 2 });
    expect(await ime.glides()).toBe(0);
    expect(await visibleMainCursors(owner.page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    await owner.page.keyboard.type("x");
    await expect.poll(ime.glides).toBeGreaterThan(0);
  } finally {
    await closeAll(owner);
  }
});

test("a Hanja replacement of a Hangul syllable snaps", async ({ browser, browserName }) => {
  test.skip(
    browserName !== "chromium",
    "IME composition can only be driven through Chromium's CDP",
  );
  const owner = await newUser(browser, "Hanja");
  try {
    const ime = await imeSession(owner);
    await ime.compose("한", { text: "한", caret: 1 });
    const hangul = await ime.glides();
    expect(hangul).toBeGreaterThan(0);
    // The conversion window picks 韓 for the syllable: the same range, now Han, so no glide.
    await ime.compose("韓", { text: "韓", caret: 1 });
    expect(await ime.glides()).toBe(hangul);
    expect(await ime.offset()).toBeLessThan(1.5);
    await ime.commit("韓", { text: "韓", caret: 1 });
    expect(await ime.glides()).toBe(hangul);
    // A Hangul syllable after the Hanja is a new place for the cursor, so it glides again.
    await ime.compose("ㄱ", { text: "韓ㄱ", caret: 2 });
    expect(await ime.glides()).toBeGreaterThan(hangul);
    await ime.compose("글", { text: "韓글", caret: 2 });
    await ime.compose("契", { text: "韓契", caret: 2 });
    await ime.commit("契", { text: "韓契", caret: 2 });
    expect(await ime.offset()).toBeLessThan(1.5);
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
    await ime.compose("か", { text: "か", caret: 1 });
    await ime.compose("かん", { text: "かん", caret: 2 });
    await ime.compose("かんじ", { text: "かんじ", caret: 3 });
    expect(await visibleMainCursors(owner.page)).toBe(1);
    expect(await ime.offset()).toBeLessThan(1.5);
    await ime.commit("漢字", { text: "漢字", caret: 2 });
    await ime.compose("さ", { text: "漢字さ", caret: 3 });
    expect(await ime.offset()).toBeLessThan(1.5);
    expect(await ime.glides()).toBe(0);
    await ime.commit("さ", { text: "漢字さ", caret: 3 });
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
