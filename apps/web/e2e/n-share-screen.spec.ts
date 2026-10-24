import { readFile } from "node:fs/promises";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { closeAll, editorText, joinByLink, newUser, waitForEditor } from "./helpers";

async function createWithFiles(page: Page, files: { path: string; content: string }[]) {
  const response = await page.context().request.post("/api/shares", {
    data: { title: "share screen", files },
  });
  expect(response.ok()).toBe(true);
  const { id } = (await response.json()) as { id: string };
  await page.goto(`/${id}`);
  await waitForEditor(page);
  return id;
}

/** Whether the focused element draws a focus ring (an outline, or the editor's overlay ring). */
async function focusRing(page: Page): Promise<{ what: string; ring: boolean }> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return { what: "nothing", ring: false };
    const editor = active.closest(".cm-editor");
    if (editor) {
      const outline = getComputedStyle(editor);
      const overlay = getComputedStyle(editor, "::after").content !== "none";
      const drawn = outline.outlineStyle !== "none" && Number.parseFloat(outline.outlineWidth) > 0;
      return { what: "editor", ring: overlay || drawn };
    }
    const style = getComputedStyle(active);
    return {
      what: active.getAttribute("data-testid") ?? active.getAttribute("aria-label") ?? "?",
      ring: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
    };
  });
}

test("controls clicked with the mouse show no focus ring; Tab shows one", async ({ browser }) => {
  const owner = await newUser(browser, "Owner", { viewport: { width: 1280, height: 800 } });
  try {
    await createWithFiles(owner.page, [
      { path: "main.ts", content: "export const a = 1;\n" },
      { path: "notes.md", content: "# notes\n" },
    ]);
    const page = owner.page;

    // CodeMirror marks itself focused a frame after the focus event.
    await page.locator(".cm-content").click();
    await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(1);
    expect(await focusRing(page)).toEqual({ what: "editor", ring: false });

    for (const id of ["files-toggle", "tab-notes.md", "tab-main.ts", "history-button"]) {
      await page.getByTestId(id).click();
      expect(await focusRing(page), id).toEqual({ what: id, ring: false });
      if (id === "history-button") await page.getByTestId(id).click();
    }

    // A menu item chosen with the mouse does not hand a keyboard ring back to the trigger.
    await page.getByTestId("menu-button").click();
    await page.getByRole("menuitem", { name: "Copy all" }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    expect((await focusRing(page)).ring, "menu trigger after a click").toBe(false);

    // From the keyboard: the tab strip, then on into the editor.
    await page.getByTestId("tab-main.ts").focus();
    await page.keyboard.press("ArrowRight");
    expect(await focusRing(page)).toEqual({ what: "tab-notes.md", ring: true });
    for (let i = 0; i < 8 && (await focusRing(page)).what !== "editor"; i++) {
      await page.keyboard.press("Tab");
    }
    await expect(page.locator(".cm-editor.cm-focused")).toHaveCount(1);
    expect(await focusRing(page)).toEqual({ what: "editor", ring: true });
  } finally {
    await closeAll(owner);
  }
});

async function userOn(browser: Browser, platform: "Win32" | "MacIntel") {
  const user = await newUser(browser, "Keys", { viewport: { width: 1280, height: 800 } });
  await user.context.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => ({ platform: value === "Win32" ? "Windows" : "macOS" }),
    });
  }, platform);
  return user;
}

for (const [platform, mod, other] of [
  ["Win32", "Ctrl", "⌘"],
  ["MacIntel", "⌘", "Ctrl"],
] as const) {
  test(`shortcut labels read ${mod} on ${platform}`, async ({ browser }) => {
    const user = await userOn(browser, platform);
    try {
      await createWithFiles(user.page, [{ path: "main.ts", content: "const a = 1;\n" }]);
      const page = user.page;

      await page.getByTestId("comments-button").hover();
      await expect(page.getByRole("tooltip")).toContainText(mod);

      await page.getByTestId("menu-button").click();
      const menu = page.getByRole("menu");
      await expect(menu).toContainText(mod);
      await expect(menu).not.toContainText(other);
      await page.keyboard.press("Escape");

      // The shortcut key is the one the labels show: ⌘ on a Mac, Ctrl elsewhere.
      await page.keyboard.press(platform === "MacIntel" ? "Meta+k" : "Control+k");
      const palette = page.getByRole("dialog");
      await expect(palette).toContainText(mod);
      await expect(palette).not.toContainText(other);
      await page.keyboard.press("Escape");

      await page.locator("body").press("?");
      const sheet = page.getByRole("dialog");
      await expect(sheet).toContainText(mod);
      await expect(sheet).not.toContainText(other);
    } finally {
      await closeAll(user);
    }
  });
}

test("a file with Windows line endings imports, edits and downloads cleanly", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createWithFiles(owner.page, [{ path: "main.ts", content: "" }]);
    const page = owner.page;

    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("dialog").getByRole("combobox").fill("upload");
    await page.keyboard.press("Enter");
    await page.getByTestId("upload-input").setInputFiles({
      name: "win.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("﻿one\r\ntwo\r\nthree\r\n"),
    });
    await expect(page.locator(".cm-line")).toHaveCount(4);

    // An edit after the CRLF lines lands where it was typed, for everyone.
    await page.locator(".cm-line").nth(2).click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect.poll(() => editorText(page)).toBe("onetwothree!");

    // Pasted CRLF text becomes one line per line.
    await page.keyboard.press("ControlOrMeta+End");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "four\r\nfive\r\n");
      document
        .querySelector(".cm-content")
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(page.locator(".cm-line")).toHaveCount(6);

    await joinByLink(guest, id);
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toBe("onetwothree!fourfive");

    await page.getByTestId("menu-button").click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download this file" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("win.txt");
    const saved = await readFile(await download.path(), "utf8");
    expect(saved).toBe("one\ntwo\nthree!\nfour\nfive\n");
  } finally {
    await closeAll(owner, guest);
  }
});
