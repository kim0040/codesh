import { expect, type Locator, type Page, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { BASE_URL } from "./env";
import { closeAll, newUser, type User, waitForEditor } from "./helpers";

/**
 * Cross-OS behaviour of the client: every shortcut, its label, the text-editing habits of each
 * OS, input-method (IME) safety and the OS-dependent features. It runs on Chromium, Firefox and
 * WebKit; the operating system is faked by overriding `navigator.platform` and
 * `navigator.userAgentData` before the page loads, which is what the app (and CodeMirror) read.
 * The expectations are spelled out here on purpose: they are what a person on that OS must see
 * and be able to press, independent of how the app stores its table.
 */

type OsName = "mac" | "windows" | "linux";

interface OsSpec {
  platform: string;
  uaPlatform: string;
  /** Playwright key chord -> the key caps the app must show for it. */
  shortcuts: Record<
    "palette" | "share" | "settings" | "comments" | "history" | "copyAll" | "format",
    { press: string; label: string[] }
  >;
  /** Chords that belong to the browser or OS on this platform and must do nothing here. */
  inert: { press: string; what: string }[];
  /** Text editing habits. */
  nav: {
    docStart: string;
    lineStart: string;
    lineEnd: string;
    wordRight: string;
    deleteWord: string;
    undo: string;
    redo: string;
    /** "foo |bar baz" (Windows: start of the next word) or "foo| bar baz". */
    afterWordRight: string;
    goToLine: string;
    replace: string;
    deleteLine: string[];
    multiCursor: string;
    notMultiCursor: string;
  };
}

const OSES: Record<OsName, OsSpec> = {
  mac: {
    platform: "MacIntel",
    uaPlatform: "macOS",
    shortcuts: {
      palette: { press: "Meta+k", label: ["⌘", "K"] },
      share: { press: "Control+Meta+s", label: ["⌃", "⌘", "S"] },
      settings: { press: "Meta+,", label: ["⌘", ","] },
      comments: { press: "Control+Meta+m", label: ["⌃", "⌘", "M"] },
      history: { press: "Control+Meta+h", label: ["⌃", "⌘", "H"] },
      copyAll: { press: "Control+Meta+c", label: ["⌃", "⌘", "C"] },
      format: { press: "Alt+Shift+f", label: ["⌥", "⇧", "F"] },
    },
    inert: [
      // Control+K is "kill line" in every Mac text field, ⌘⌥H hides other apps, ⌘⌥C opens the inspector.
      { press: "Control+k", what: "Control+K must not open the palette" },
      { press: "Meta+Alt+h", what: "⌘⌥H is the OS's Hide Others" },
      { press: "Meta+Alt+c", what: "⌘⌥C is the browser's inspector" },
    ],
    nav: {
      docStart: "Meta+ArrowUp",
      lineStart: "Meta+ArrowLeft",
      lineEnd: "Meta+ArrowRight",
      wordRight: "Alt+ArrowRight",
      deleteWord: "Alt+Backspace",
      undo: "Meta+z",
      redo: "Meta+Shift+Z",
      afterWordRight: "foo| bar baz",
      goToLine: "Control+g",
      replace: "Meta+Alt+f",
      deleteLine: ["Meta+Shift+K"],
      multiCursor: "Meta",
      notMultiCursor: "Control",
    },
  },
  windows: {
    platform: "Win32",
    uaPlatform: "Windows",
    shortcuts: {
      palette: { press: "Control+k", label: ["Ctrl", "K"] },
      share: { press: "Control+Alt+s", label: ["Ctrl", "Alt", "S"] },
      settings: { press: "Control+,", label: ["Ctrl", ","] },
      comments: { press: "Control+Alt+m", label: ["Ctrl", "Alt", "M"] },
      history: { press: "Control+Alt+h", label: ["Ctrl", "Alt", "H"] },
      copyAll: { press: "Control+Alt+c", label: ["Ctrl", "Alt", "C"] },
      format: { press: "Alt+Shift+f", label: ["Alt", "Shift", "F"] },
    },
    inert: [{ press: "Meta+k", what: "Win+K is Cast; the Windows key is not Ctrl" }],
    nav: {
      docStart: "Control+Home",
      lineStart: "Home",
      lineEnd: "End",
      wordRight: "Control+ArrowRight",
      deleteWord: "Control+Backspace",
      undo: "Control+z",
      redo: "Control+y",
      afterWordRight: "foo |bar baz",
      goToLine: "Control+Alt+g",
      replace: "Control+h",
      deleteLine: ["Control+Shift+K", "Control+Alt+k"],
      multiCursor: "Control",
      notMultiCursor: "Alt",
    },
  },
  linux: {
    platform: "Linux x86_64",
    uaPlatform: "Linux",
    shortcuts: {
      palette: { press: "Control+k", label: ["Ctrl", "K"] },
      share: { press: "Control+Alt+s", label: ["Ctrl", "Alt", "S"] },
      settings: { press: "Control+,", label: ["Ctrl", ","] },
      comments: { press: "Control+Alt+m", label: ["Ctrl", "Alt", "M"] },
      history: { press: "Control+Alt+h", label: ["Ctrl", "Alt", "H"] },
      copyAll: { press: "Control+Alt+c", label: ["Ctrl", "Alt", "C"] },
      format: { press: "Alt+Shift+f", label: ["Alt", "Shift", "F"] },
    },
    inert: [{ press: "Meta+k", what: "Super+K is the desktop's, not Ctrl" }],
    nav: {
      docStart: "Control+Home",
      lineStart: "Home",
      lineEnd: "End",
      wordRight: "Control+ArrowRight",
      deleteWord: "Control+Backspace",
      undo: "Control+z",
      redo: "Control+Shift+Z",
      afterWordRight: "foo| bar baz",
      goToLine: "Control+Alt+g",
      replace: "Control+h",
      deleteLine: ["Control+Shift+K", "Control+Alt+k"],
      multiCursor: "Control",
      notMultiCursor: "Alt",
    },
  },
};

const UNFORMATTED_TS = "const   a  =  1;\nfunction f( x ){return x+1}\n";

/** Fakes the OS before any page script runs. */
async function onOs(user: User, os: OsName): Promise<void> {
  const { platform, uaPlatform } = OSES[os];
  await user.context.addInitScript(
    ({ platform, uaPlatform }) => {
      Object.defineProperty(Navigator.prototype, "platform", {
        get: () => platform,
        configurable: true,
      });
      const ua = (globalThis as { NavigatorUAData?: { prototype: object } }).NavigatorUAData;
      if (ua) {
        Object.defineProperty(ua.prototype, "platform", {
          get: () => uaPlatform,
          configurable: true,
        });
      }
    },
    { platform, uaPlatform },
  );
}

async function openShare(user: User, files: { path: string; content: string }[]): Promise<string> {
  const response = await user.context.request.post("/api/shares", {
    data: { title: "cross-os", files },
  });
  expect(response.ok()).toBe(true);
  const { id } = (await response.json()) as { id: string };
  await user.page.goto(`/${id}`);
  await waitForEditor(user.page);
  return id;
}

const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });
/** Moves focus off the editor, as when someone clicks the page background, so "?" is not typed. */
async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const keycaps = (scope: Locator) => scope.locator("kbd").allTextContents();

async function focusEditor(page: Page): Promise<void> {
  await page.locator(".cm-content").click();
  await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(1);
}

/** The document with its line breaks (`.cm-content`'s own text runs the lines together). */
async function docText(page: Page): Promise<string> {
  return (await page.locator(".cm-line").allTextContents()).join("\n");
}

/** The document with a "|" where the caret is; reads the selection, so it never edits the text. */
async function textWithCaret(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")];
    const selection = getSelection();
    const node = selection?.anchorNode;
    return lines
      .map((line) => {
        const text = line.textContent ?? "";
        if (!selection || !node || !line.contains(node)) return text;
        const range = document.createRange();
        range.setStart(line, 0);
        range.setEnd(node, selection.anchorOffset);
        const column = range.toString().length;
        return `${text.slice(0, column)}|${text.slice(column)}`;
      })
      .join("\n");
  });
}

/** `text` with a "|" where `caret` ("foo| bar") has it. */
function withMarker(caret: string, text: string): string {
  const at = caret.indexOf("|");
  return `${text.slice(0, at)}|${text.slice(at)}`;
}

for (const os of ["mac", "windows", "linux"] as const) {
  const spec = OSES[os];

  test.describe(`${os}: shortcuts`, () => {
    test("each shortcut fires its action", async ({ browser }) => {
      const user = await newUser(browser, "Keys", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        await openShare(user, [{ path: "main.ts", content: UNFORMATTED_TS }]);
        await focusEditor(page);
        const closeWith = async (name: string) => {
          await page.keyboard.press("Escape");
          await expect(dialog(page, name)).toBeHidden();
          await focusEditor(page);
        };

        await page.keyboard.press(spec.shortcuts.palette.press);
        await expect(page.getByRole("combobox", { name: "Command palette" })).toBeVisible();
        await closeWith("Command palette");

        await page.keyboard.press("F1");
        await expect(page.getByRole("combobox", { name: "Command palette" })).toBeVisible();
        await closeWith("Command palette");

        await page.keyboard.press(spec.shortcuts.share.press);
        await expect(dialog(page, "Share")).toBeVisible();
        await closeWith("Share");

        await page.keyboard.press(spec.shortcuts.settings.press);
        await expect(dialog(page, "Editor settings")).toBeVisible();
        await closeWith("Editor settings");

        await page.keyboard.press(spec.shortcuts.comments.press);
        await expect(dialog(page, "Comments")).toBeVisible();
        await closeWith("Comments");

        await page.keyboard.press(spec.shortcuts.copyAll.press);
        await expect(page.getByText(/Copied all code|Couldn.t copy/).first()).toBeVisible();

        await page.keyboard.press(spec.shortcuts.format.press);
        await expect(page.getByText("Code formatted", { exact: true })).toBeVisible();
        expect(await docText(page)).toContain("const a = 1;");

        // The "?" key opens the sheet from anywhere that is not a text field.
        await blurFocus(page);
        await page.keyboard.press("?");
        await expect(dialog(page, "Keyboard shortcuts")).toBeVisible();
        await closeWith("Keyboard shortcuts");

        await page.keyboard.press(spec.shortcuts.history.press);
        await expect(page.getByTestId("history-view")).toBeVisible();
      } finally {
        await closeAll(user);
      }
    });

    test("keys that belong to the browser or the OS here do nothing", async ({ browser }) => {
      const user = await newUser(browser, "Inert", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
        await focusEditor(page);
        for (const { press, what } of spec.inert) {
          await page.keyboard.press(press);
          await page.waitForTimeout(250);
          await expect(page.getByRole("dialog"), what).toHaveCount(0);
        }
      } finally {
        await closeAll(user);
      }
    });

    test("labels in the sheet, the palette, the tooltips and the menu match the keys", async ({
      browser,
    }) => {
      const user = await newUser(browser, "Labels", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        await openShare(user, [{ path: "main.ts", content: UNFORMATTED_TS }]);

        // Tooltips on the top bar.
        await page.getByTestId("comments-button").hover();
        const tip = page.getByRole("tooltip").first();
        await expect(tip).toBeVisible();
        expect(await keycaps(tip)).toEqual(spec.shortcuts.comments.label);
        await page.mouse.move(0, 0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await page.getByTestId("history-button").hover();
        await expect
          .poll(async () => keycaps(page.getByRole("tooltip").last()))
          .toEqual(spec.shortcuts.history.label);

        // The menu.
        await page.getByTestId("menu-button").click();
        const copyItem = page.getByRole("menuitem", { name: /^Copy all/ });
        expect(await keycaps(copyItem)).toEqual(spec.shortcuts.copyAll.label);
        const formatItem = page.getByRole("menuitem", { name: /^Format code/ });
        expect(await keycaps(formatItem)).toEqual(spec.shortcuts.format.label);
        await page.keyboard.press("Escape");

        // The command palette.
        await page.keyboard.press(spec.shortcuts.palette.press);
        const options: [string, string[]][] = [
          ["Share", spec.shortcuts.share.label],
          ["Settings", spec.shortcuts.settings.label],
          ["Comments", spec.shortcuts.comments.label],
          ["History", spec.shortcuts.history.label],
          ["Copy all", spec.shortcuts.copyAll.label],
          ["Format code", spec.shortcuts.format.label],
        ];
        const combobox = page.getByRole("combobox", { name: "Command palette" });
        for (const [name, label] of options) {
          await combobox.fill(name);
          const option = page.getByRole("option", { name: new RegExp(`^${name}`) }).first();
          await expect(option).toBeVisible();
          expect(await keycaps(option), `palette: ${name}`).toEqual(label);
        }
        await page.keyboard.press("Escape");

        // The shortcut sheet, with this OS's notes.
        await blurFocus(page);
        await page.keyboard.press("?");
        const sheet = page.getByTestId("shortcut-sheet");
        await expect(sheet).toBeVisible();
        const rows = {
          palette: spec.shortcuts.palette.label,
          share: spec.shortcuts.share.label,
          settings: spec.shortcuts.settings.label,
          comments: spec.shortcuts.comments.label,
          history: spec.shortcuts.history.label,
          copyAll: spec.shortcuts.copyAll.label,
          format: spec.shortcuts.format.label,
        };
        for (const [id, label] of Object.entries(rows)) {
          const caps = await keycaps(sheet.getByTestId(`shortcut-${id}`));
          expect(caps.slice(0, label.length), `sheet: ${id}`).toEqual(label);
        }
        const notes = await sheet.getByTestId("shortcut-notes").innerText();
        if (os === "mac") expect(notes).toContain("⌃⌘");
        if (os === "windows") expect(notes).toContain("AltGr");
        if (os === "linux") expect(notes).toMatch(/Alt\+drag/);
        if (os !== "mac") expect(notes).toContain("Ctrl+Shift+K");
        expect(notes).toMatch(/Korean, Japanese or Chinese/);
        // Linux says where the window manager takes Ctrl+Alt+arrows, and the palette has the commands.
        if (os === "linux") {
          await page.keyboard.press("Escape");
          await page.keyboard.press(spec.shortcuts.palette.press);
          await combobox.fill("cursor");
          await expect(
            page.getByRole("option", { name: /cursor on the line above/ }),
          ).toBeVisible();
          await expect(
            page.getByRole("option", { name: /cursor on the line below/ }),
          ).toBeVisible();
        }
      } finally {
        await closeAll(user);
      }
    });
  });

  test.describe(`${os}: text editing`, () => {
    test("word, line and document movement, deleting a word, undo and redo", async ({
      browser,
    }) => {
      const user = await newUser(browser, "Nav", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        const { nav } = spec;
        await openShare(user, [{ path: "lines.txt", content: "foo bar baz\nsecond line" }]);
        await focusEditor(page);

        await page.keyboard.press(nav.docStart);
        await page.keyboard.press(nav.wordRight);
        expect(await textWithCaret(page)).toBe(
          withMarker(nav.afterWordRight, "foo bar baz\nsecond line"),
        );

        await page.keyboard.press(nav.lineEnd);
        await page.keyboard.press(nav.deleteWord);
        expect(await docText(page)).toBe("foo bar \nsecond line");

        await page.keyboard.press(nav.undo);
        expect(await docText(page)).toBe("foo bar baz\nsecond line");
        await page.keyboard.press(nav.redo);
        expect(await docText(page)).toBe("foo bar \nsecond line");

        await page.keyboard.press(nav.lineStart);
        expect((await textWithCaret(page)).startsWith("|foo bar")).toBe(true);
      } finally {
        await closeAll(user);
      }
    });

    test("go to line, replace and delete line", async ({ browser }) => {
      const user = await newUser(browser, "Lines", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        const { nav } = spec;
        await openShare(user, [{ path: "lines.txt", content: "one\ntwo\nthree\nfour" }]);
        await focusEditor(page);

        await page.keyboard.press(nav.goToLine);
        await expect(page.locator(".cm-goto-line")).toBeVisible();
        await page.locator(".cm-goto-line input[name=line]").fill("3");
        await page.keyboard.press("Enter");
        await expect(page.locator(".cm-goto-line")).toBeHidden();
        expect((await textWithCaret(page)).split("\n")[2]?.startsWith("|")).toBe(true);

        await page.keyboard.press(nav.replace);
        await expect(page.locator('.cm-search input[name="replace"]')).toBeFocused();
        await page.keyboard.press("Escape");

        // Every delete-line binding of this OS removes the line the caret is on.
        for (const chord of nav.deleteLine) {
          await focusEditor(page);
          await page.keyboard.press("Control+Home");
          await page.keyboard.press("ArrowDown");
          const before = (await docText(page)).split("\n").length;
          await page.keyboard.press(chord);
          expect((await docText(page)).split("\n").length, chord).toBe(before - 1);
        }
      } finally {
        await closeAll(user);
      }
    });

    test("a second cursor comes from the OS's own click, not from Control-click on a Mac", async ({
      browser,
    }) => {
      const user = await newUser(browser, "Cursors", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        const { nav } = spec;
        await openShare(user, [{ path: "lines.txt", content: "one\ntwo\nthree" }]);
        await focusEditor(page);
        const cursors = page.locator(".cm-cursorLayer .cm-cursor");
        const lines = page.locator(".cm-line");

        await lines.nth(0).click();
        await lines.nth(2).click({ modifiers: [nav.notMultiCursor as "Control" | "Alt"] });
        await expect(cursors).toHaveCount(1);

        await lines.nth(0).click();
        await lines.nth(2).click({ modifiers: [nav.multiCursor as "Meta" | "Control"] });
        await expect(cursors).toHaveCount(2);
        await page.keyboard.type("X");
        expect(await docText(page)).toBe("oneX\ntwo\nthreeX");
      } finally {
        await closeAll(user);
      }
    });

    test("Alt or Shift+Alt with a drag selects a rectangle", async ({ browser }) => {
      const user = await newUser(browser, "Rect", { viewport: { width: 1280, height: 800 } });
      try {
        await onOs(user, os);
        const page = user.page;
        await openShare(user, [
          {
            path: "grid.txt",
            content:
              "abcdefghijklmnopqrstuvwxyz\nabcdefghijklmnopqrstuvwxyz\nabcdefghijklmnopqrstuvwxyz",
          },
        ]);
        await focusEditor(page);
        const first = await page.locator(".cm-line").nth(0).boundingBox();
        const last = await page.locator(".cm-line").nth(2).boundingBox();
        if (!first || !last) throw new Error("no lines");
        for (const held of [["Alt"], ["Shift", "Alt"]]) {
          await page.locator(".cm-line").nth(0).click();
          for (const key of held) await page.keyboard.down(key);
          await page.mouse.move(first.x + 40, first.y + 6);
          await page.mouse.down();
          await page.mouse.move(first.x + 120, last.y + 6, { steps: 4 });
          await page.mouse.up();
          for (const key of held.reverse()) await page.keyboard.up(key);
          await expect(
            page.locator(".cm-selectionLayer .cm-selectionBackground"),
            held.join("+"),
          ).toHaveCount(3);
        }
      } finally {
        await closeAll(user);
      }
    });
  });
}

test.describe("Option and AltGr keep typing characters", () => {
  test("Option+letter with no shortcut is left to the keyboard on a Mac", async ({ browser }) => {
    const user = await newUser(browser, "Option", { viewport: { width: 1280, height: 800 } });
    try {
      await onOs(user, "mac");
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: UNFORMATTED_TS }]);
      await focusEditor(page);
      // A Mac turns Option+F into "ƒ", Option+G into "©" and Shift+Option+F into "Ï"; those key
      // presses must reach the text, so nothing may cancel the plain Option ones.
      const outcome = await page.evaluate(() => {
        const send = (init: KeyboardEventInit) => {
          const event = new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...init,
          });
          document.querySelector(".cm-content")?.dispatchEvent(event);
          return event.defaultPrevented;
        };
        return {
          optionF: send({ key: "ƒ", code: "KeyF", altKey: true }),
          optionG: send({ key: "©", code: "KeyG", altKey: true }),
          optionS: send({ key: "ß", code: "KeyS", altKey: true }),
          optionShiftF: send({ key: "Ï", code: "KeyF", altKey: true, shiftKey: true }),
        };
      });
      expect(outcome.optionF).toBe(false);
      expect(outcome.optionG).toBe(false);
      expect(outcome.optionS).toBe(false);
      // Shift+Option+F is the formatter: it fires by its key position and is cancelled so no "Ï" is typed.
      expect(outcome.optionShiftF).toBe(true);
      await expect(page.getByText("Code formatted", { exact: true })).toBeVisible();
    } finally {
      await closeAll(user);
    }
  });

  test("a Windows AltGr press (Ctrl+Alt with AltGraph) types instead of starting a shortcut", async ({
    browser,
  }) => {
    const user = await newUser(browser, "AltGr", { viewport: { width: 1280, height: 800 } });
    try {
      await onOs(user, "windows");
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await focusEditor(page);
      const prevented = await page.evaluate(() => {
        // Polish AltGr+S types "ś"; Windows reports it as Ctrl+Alt.
        const event = new KeyboardEvent("keydown", {
          key: "ś",
          code: "KeyS",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, "getModifierState", {
          value: (name: string) => name === "AltGraph",
        });
        document.querySelector(".cm-content")?.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(false);
      await expect(dialog(page, "Share")).toBeHidden();
    } finally {
      await closeAll(user);
    }
  });
});

test.describe("input methods (IME)", () => {
  const composingKey = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    code: key,
    keyCode: 229,
    isComposing: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });

  test("Enter, Escape and shortcuts do nothing while a syllable is being composed", async ({
    browser,
  }) => {
    const user = await newUser(browser, "Ime", { viewport: { width: 1280, height: 800 } });
    try {
      await onOs(user, "windows");
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);

      // Ctrl+K and F1 while composing: no palette.
      await page.locator(".cm-content").click();
      await page
        .locator(".cm-content")
        .dispatchEvent("keydown", composingKey("k", { code: "KeyK", ctrlKey: true }));
      await page
        .locator(".cm-content")
        .dispatchEvent("keydown", composingKey("F1", { code: "F1" }));
      await page.waitForTimeout(200);
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // The palette: composing Enter does not run the highlighted command.
      await page.keyboard.press("Control+k");
      const combobox = page.getByRole("combobox", { name: "Command palette" });
      await combobox.fill("Share");
      await combobox.dispatchEvent("keydown", composingKey("Enter", { code: "Enter" }));
      // Safari sends the confirming Enter after compositionend: not composing, still keyCode 229.
      await combobox.dispatchEvent(
        "keydown",
        composingKey("Enter", { code: "Enter", isComposing: false }),
      );
      await page.waitForTimeout(250);
      await expect(combobox).toBeVisible();
      await expect(dialog(page, "Share")).toHaveCount(0);

      // Escape that cancels the composition does not close the palette.
      await combobox.dispatchEvent("keydown", composingKey("Escape", { code: "Escape" }));
      await page.waitForTimeout(250);
      await expect(combobox).toBeVisible();

      // The same keys outside composition work.
      await page.keyboard.press("Enter");
      await expect(dialog(page, "Share")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page, "Share")).toBeHidden();

      // The title commits on Enter only once the syllable is final.
      const title = page.getByTestId("title");
      await title.click();
      await title.fill("한글 제목");
      await title.dispatchEvent("keydown", composingKey("Enter", { code: "Enter" }));
      await expect(title).toBeFocused();
      await title.dispatchEvent(
        "keydown",
        composingKey("Enter", { code: "Enter", isComposing: false }),
      );
      await expect(title).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(title).not.toBeFocused();
      await expect(title).toHaveValue("한글 제목");
    } finally {
      await closeAll(user);
    }
  });

  test("a form does not submit on the Enter that confirms a syllable", async ({ browser }) => {
    const user = await newUser(browser, "Form", { viewport: { width: 1280, height: 800 } });
    try {
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await page.getByTestId("add-file").click();
      const input = page.getByTestId("file-name-input");
      await input.fill("한글.ts");
      // Safari's confirming Enter is a plain key press that would submit the form.
      const prevented = await input.evaluate((element) => {
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(true);
      await expect(input).toBeVisible();
    } finally {
      await closeAll(user);
    }
  });

  test("a composition survives a remote edit and the other cursor does not jump", async ({
    browser,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "IME composition can only be driven through Chromium's CDP",
    );
    const owner = await newUser(browser, "Typist", { viewport: { width: 1280, height: 800 } });
    const peer = await newUser(browser, "Remote", { viewport: { width: 1280, height: 800 } });
    try {
      const id = await openShare(owner, [{ path: "poem.txt", content: "alpha\nbeta" }]);
      await peer.page.goto(`/${id}`);
      await waitForEditor(peer.page);

      const typist = owner.page;
      await focusEditor(typist);
      await typist.keyboard.press("Control+End");
      const cdp = await owner.context.newCDPSession(typist);
      const compose = (text: string) =>
        cdp.send("Input.imeSetComposition", {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });

      await compose("ㅎ");
      await compose("하");
      await expect(typist.locator(".cm-content")).toContainText("beta하");

      // While the syllable is open, the other person edits before it and on another line.
      await peer.page.locator(".cm-content").click();
      await peer.page.keyboard.press("Control+Home");
      await peer.page.keyboard.type("REMOTE ");
      await expect(typist.locator(".cm-content")).toContainText("REMOTE alpha");

      await compose("한");
      await typist.keyboard.insertText("한");
      await typist.keyboard.insertText("글");

      await expect.poll(() => docText(peer.page)).toContain("beta한글");
      expect(await docText(typist)).toBe(await docText(peer.page));
      expect(await docText(typist)).toBe("REMOTE alpha\nbeta한글");

      // The typist's caret, seen by the other person, sits at the end of the second line.
      const caret = await peer.page.locator(".cm-remote-caret").first().boundingBox();
      const second = await peer.page.locator(".cm-line").nth(1).boundingBox();
      expect(caret && second).toBeTruthy();
      if (caret && second) {
        expect(caret.y).toBeGreaterThanOrEqual(second.y - 2);
        expect(caret.y).toBeLessThanOrEqual(second.y + second.height);
      }
    } finally {
      await closeAll(owner, peer);
    }
  });
});

test.describe("OS-dependent features", () => {
  test("copying falls back to a selection when the Clipboard API is missing, inside a dialog", async ({
    browser,
  }) => {
    const user = await newUser(browser, "Copy", { viewport: { width: 1280, height: 800 } });
    try {
      // A plain-http server has no navigator.clipboard.
      await user.context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
        const copied: string[] = [];
        (window as unknown as { __copied: string[] }).__copied = copied;
        const original = document.execCommand.bind(document);
        document.execCommand = (command: string, ...rest: [boolean?, string?]) => {
          if (command === "copy") {
            copied.push(String(document.getSelection()));
            return true;
          }
          return original(command, ...rest);
        };
      });
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await page.getByTestId("share-button").click();
      const share = dialog(page, "Share");
      await expect(share).toBeVisible();
      const code = ((await page.getByTestId("join-code").textContent()) ?? "").replace(/\s/g, "");
      await page.getByTestId("copy-code").click();
      await page.getByTestId("copy-link").click();
      const copied = await page.evaluate(
        () => (window as unknown as { __copied: string[] }).__copied,
      );
      expect(copied[0]?.replace(/\s/g, "")).toBe(code);
      expect(copied[1]).toMatch(/^http:\/\/localhost:\d+\/\w+/);
      // The dialog and the textarea trick left no stray element behind.
      await expect(share).toBeVisible();
      await expect(page.locator("textarea[readonly][aria-hidden=true]")).toHaveCount(0);
    } finally {
      await closeAll(user);
    }
  });

  test("downloads get a name every desktop can save", async ({ browser }) => {
    const user = await newUser(browser, "Download", { viewport: { width: 1280, height: 800 } });
    try {
      const page = user.page;
      await openShare(user, [
        { path: "aux.txt", content: "reserved on Windows\n" },
        { path: "notes.md", content: "# notes\n" },
      ]);
      await page.getByTestId("menu-button").click();
      await expect(page.getByRole("menuitem", { name: "Download this file" })).toBeVisible();
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Download this file" }).click(),
      ]);
      expect(file.suggestedFilename()).toMatch(/^_?(aux|notes)\.(txt|md)$/);
      await expect(page.getByRole("menu")).toBeHidden();
      await page.getByTestId("menu-button").click();
      await expect(page.getByRole("menuitem", { name: "Download all (.zip)" })).toBeVisible();
      const [zip] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: "Download all (.zip)" }).click(),
      ]);
      expect(zip.suggestedFilename()).toMatch(/\.zip$/);
    } finally {
      await closeAll(user);
    }
  });

  test("a .zip from Finder or Explorer imports without its junk files", async ({ browser }) => {
    const user = await newUser(browser, "Zip", { viewport: { width: 1280, height: 800 } });
    try {
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "" }]);
      const archive = zipSync({
        "project/src/app.ts": strToU8("export const app = 1;\n"),
        "project/.DS_Store": strToU8("Bud1"),
        "project/Thumbs.db": strToU8("db"),
        "__MACOSX/project/src/._app.ts": strToU8("\u0000\u0005"),
        "project\\win\\readme.md": strToU8("# from windows\r\n"),
      });
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox", { name: "Command palette" }).fill("Upload");
      await page.keyboard.press("Enter");
      await expect(dialog(page, "Upload files or a folder")).toBeVisible();
      await page.getByTestId("upload-input").setInputFiles({
        name: "project.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
      });
      await expect(dialog(page, "Upload files or a folder")).toBeHidden();
      await page.getByTestId("files-toggle").click();
      const tree = page.getByTestId("file-tree");
      await expect(tree).toContainText("app.ts");
      await expect(tree).toContainText("readme.md");
      await expect(tree).not.toContainText("DS_Store");
      await expect(tree).not.toContainText("Thumbs");
      await expect(tree).not.toContainText("._app");
    } finally {
      await closeAll(user);
    }
  });

  test("the projector opens over the page and Esc leaves it", async ({ browser }) => {
    const user = await newUser(browser, "Projector", { viewport: { width: 1280, height: 800 } });
    try {
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await page.getByTestId("share-button").click();
      await page.getByTestId("projector-button").click();
      const projector = page.getByTestId("projector");
      await expect(projector).toBeVisible();
      const box = await projector.boundingBox();
      expect(box?.width).toBe(await page.evaluate(() => window.innerWidth));
      await page.keyboard.press("Escape");
      await expect(projector).toBeHidden();
    } finally {
      await closeAll(user);
    }
  });

  test("the join QR code is vector art, sharp at 125 % and 150 % scaling", async ({ browser }) => {
    for (const scale of [1.25, 1.5]) {
      const context = await browser.newContext({
        baseURL: BASE_URL,
        deviceScaleFactor: scale,
        extraHTTPHeaders: { "X-Gachipad": "1" },
        locale: "en-US",
      });
      try {
        const name = `Scale${scale}`.replace(".", "");
        expect((await context.request.patch("/api/session", { data: { name } })).ok()).toBe(true);
        const page = await context.newPage();
        const user: User = { context, page, name };
        await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
        await page.getByTestId("share-button").click();
        const qr = page.getByTestId("qr");
        await expect(qr).toBeVisible();
        expect(await qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
        expect(await qr.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(
          0,
        );
        expect(await page.evaluate(() => window.devicePixelRatio)).toBe(scale);
      } finally {
        await context.close();
      }
    }
  });

  test("system notifications: unsupported and blocked browsers explain themselves", async ({
    browser,
  }) => {
    const unsupported = await newUser(browser, "NoNotify", {
      viewport: { width: 1280, height: 800 },
    });
    const blocked = await newUser(browser, "Blocked", { viewport: { width: 1280, height: 800 } });
    try {
      // iOS Safari outside a Home Screen app has no Notification at all.
      await unsupported.context.addInitScript(() => {
        Reflect.deleteProperty(window, "Notification");
      });
      await openShare(unsupported, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await unsupported.page.keyboard.press("Control+,");
      const settings = dialog(unsupported.page, "Editor settings");
      await expect(settings).toContainText("cannot show system notifications");
      await expect(settings.getByRole("switch", { name: /system notifications/ })).toBeDisabled();

      await blocked.context.addInitScript(() => {
        class Blocked {
          static permission: NotificationPermission = "denied";
          static requestPermission() {
            return Promise.resolve("denied" as NotificationPermission);
          }
        }
        Object.defineProperty(window, "Notification", { value: Blocked, configurable: true });
      });
      await openShare(blocked, [{ path: "main.ts", content: "let a = 1;\n" }]);
      await blocked.page.keyboard.press("Control+,");
      await expect(dialog(blocked.page, "Editor settings")).toContainText("blocked for this site");
    } finally {
      await closeAll(unsupported, blocked);
    }
  });

  test("fonts, reduced motion and increased contrast follow the system", async ({
    browser,
    browserName,
  }) => {
    const user = await newUser(browser, "Media", { viewport: { width: 1280, height: 800 } });
    try {
      const page = user.page;
      await openShare(user, [{ path: "main.ts", content: "let a = 1;\n" }]);
      const stack = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(stack).toContain("Pretendard");
      expect(stack).toContain("Apple Color Emoji");
      expect(stack).toContain("Segoe UI Emoji");
      expect(stack).toContain("Noto Color Emoji");

      // Firefox has no `prefers-contrast` to emulate; the rest is checked there too.
      await page.emulateMedia({
        reducedMotion: "reduce",
        ...(browserName === "firefox" ? {} : { contrast: "more" as const }),
      });
      const tokens = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const probe = document.createElement("div");
        probe.style.cssText = "border:1px solid var(--border);color:var(--border-control)";
        document.body.append(probe);
        const out = {
          duration: style.getPropertyValue("--duration-normal").trim(),
          border: getComputedStyle(probe).borderTopColor,
          control: getComputedStyle(probe).color,
        };
        probe.remove();
        return out;
      });
      expect(tokens.duration).toBe("0.01ms");
      if (browserName !== "firefox") expect(tokens.border).toBe(tokens.control);
    } finally {
      await closeAll(user);
    }
  });
});
