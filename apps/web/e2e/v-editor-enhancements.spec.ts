import { expect, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  joinByLink,
  newUser,
  openShareDialog,
  type User,
  waitForEditor,
} from "./helpers";

async function chooseLanguage(page: User["page"], language: string) {
  await page.getByTestId("language-button").click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("searchbox", { name: "Search languages" }).fill(language);
  await picker.getByRole("button", { name: language, exact: true }).click();
}

async function chooseKeymap(page: User["page"], keymap: "Vim" | "Emacs") {
  await page.getByTestId("settings-button").click();
  await page.getByRole("combobox", { name: "Key bindings" }).click();
  await page.getByRole("option", { name: keymap, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.locator(".cm-content").click();
}

async function editLink(page: User["page"], shareId: string): Promise<string> {
  const dialog = await openShareDialog(page, "Access");
  const patched = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/shares/${shareId}`) && response.request().method() === "PATCH",
  );
  await dialog.getByTestId("access-view").click();
  await patched;
  await dialog.getByRole("tab", { name: "Code and QR" }).click();
  await dialog.getByRole("button", { name: "Edit link" }).click();
  const link = await dialog.getByTestId("share-link").inputValue();
  await closeDialog(page);
  return link;
}

test("Python completion opens manually, accepts Tab and Enter, and leaves Tab indentation intact", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    await createShare(owner.page);
    await chooseLanguage(owner.page, "Python");
    await expect(owner.page.getByTestId("language-button")).toHaveAccessibleName(/Python/);

    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.press("Control+Space");
    const listbox = owner.page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(owner.page.locator(".cm-content")).toBeFocused();

    await owner.page.keyboard.type("pr");
    await expect(listbox.getByRole("option", { name: /print/ })).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(listbox).toBeHidden();
    await owner.page.keyboard.press("Control+A");
    await owner.page.keyboard.press("Backspace");
    await owner.page.keyboard.press("Tab");
    await expect.poll(() => editorText(owner.page)).toBe("  ");

    await owner.page.keyboard.press("Control+A");
    await owner.page.keyboard.press("Backspace");
    await owner.page.keyboard.type("pr");
    await expect(listbox.getByRole("option", { name: /print/ })).toBeVisible();
    await expect(owner.page.locator(".cm-content")).toBeFocused();
    await owner.page.keyboard.press("Tab");
    await expect.poll(() => editorText(owner.page)).toBe("print");

    await owner.page.keyboard.press("Control+A");
    await owner.page.keyboard.press("Backspace");
    await owner.page.keyboard.type("pr");
    await expect(listbox.getByRole("option", { name: /print/ })).toBeVisible();
    await owner.page.keyboard.press("Enter");
    await expect.poll(() => editorText(owner.page)).toBe("print");
  } finally {
    await closeAll(owner);
  }
});

test("Vim insert mode and Emacs use completion before the Tab indent binding", async ({
  browser,
}) => {
  for (const keymap of ["Vim", "Emacs"] as const) {
    const owner = await newUser(browser, `${keymap}Owner`);
    try {
      await createShare(owner.page);
      await chooseLanguage(owner.page, "Python");
      await chooseKeymap(owner.page, keymap);
      await owner.page.locator(".cm-content").click();
      if (keymap === "Vim") await owner.page.keyboard.press("i");
      await owner.page.keyboard.type("pr");
      const listbox = owner.page.getByRole("listbox");
      await expect(listbox.getByRole("option", { name: /print/ })).toBeVisible();
      await expect(owner.page.locator(".cm-content")).toBeFocused();
      await owner.page.keyboard.press("Tab");
      await expect.poll(() => editorText(owner.page)).toBe("print");
    } finally {
      await closeAll(owner);
    }
  }
});

test("completion can be disabled and stays disabled after reload", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    await createShare(owner.page);
    await chooseLanguage(owner.page, "Python");
    await owner.page.getByTestId("settings-button").click();
    await owner.page.getByTestId("switch-code-completion").click();
    await expect(owner.page.getByTestId("switch-code-completion")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await owner.page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("pr");
    await expect(owner.page.getByRole("listbox")).toBeHidden();

    await owner.page.reload();
    await waitForEditor(owner.page);
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.press("Control+A");
    await owner.page.keyboard.press("Backspace");
    await owner.page.keyboard.type("pr");
    await expect(owner.page.getByRole("listbox")).toBeHidden();
  } finally {
    await closeAll(owner);
  }
});

test("viewers do not get completion from remote edits or Ctrl+Space", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const viewer = await newUser(browser, "Viewer");
  try {
    const id = await createShare(owner.page);
    await expect(owner.page.getByTestId("tab-untitled")).toBeVisible();
    await chooseLanguage(owner.page, "Python");
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("access-view").click();
    await patched;
    await dialog.getByRole("tab", { name: "Code and QR" }).click();
    const viewUrl = await dialog.getByTestId("share-link").inputValue();
    await closeDialog(owner.page);
    await viewer.page.goto(new URL(viewUrl).pathname);
    await waitForEditor(viewer.page);
    await viewer.page.locator(".cm-content").click();

    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type("pr");
    await expect(
      owner.page.getByRole("listbox").getByRole("option", { name: /print/ }),
    ).toBeVisible();
    await expect.poll(() => editorText(viewer.page)).toBe("pr");
    await viewer.page.waitForTimeout(600);
    await expect(viewer.page.getByRole("listbox")).toBeHidden();
    await viewer.page.keyboard.press("Control+Space");
    await expect(viewer.page.getByRole("listbox")).toBeHidden();
  } finally {
    await closeAll(owner, viewer);
  }
});

test("typing in an untitled text file suggests a language and syncs the choice", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const owner = await newUser(browser, "Owner");
  const editor = await newUser(browser, "Editor");
  try {
    const id = await createShare(owner.page);
    await expect(owner.page.getByTestId("tab-untitled")).toBeVisible();
    const url = await editLink(owner.page, id);
    expect(url).toMatch(/#key=/);
    const parsed = new URL(url);
    await joinByLink(editor, id, parsed.hash);
    await waitForEditor(editor.page);

    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.type(
      'from math import sqrt, pi\nresult = f"sqrt: {sqrt(9)}"\nif __name__ == "__main__":\n    values = [None, True, False]\n    try:\n        print(len(values))\n    except ValueError:\n        print(result)\n    else:\n        for value in values:\n            print(f"{value}")',
    );
    const suggestion = owner.page.getByTestId("language-suggestion");
    await expect(suggestion).toContainText("Looks like Python", { timeout: 10_000 });
    await suggestion.getByRole("button", { name: "Use", exact: true }).click();
    await expect(owner.page.getByTestId("language-button")).toHaveAccessibleName(/Python/);
    await expect(editor.page.getByTestId("language-button")).toHaveAccessibleName(/Python/, {
      timeout: 10_000,
    });

    const dialog = await openShareDialog(owner.page, "Send");
    const tablist = dialog.getByRole("tablist");
    await expect
      .poll(() => tablist.evaluate((element) => element.scrollHeight <= element.clientHeight))
      .toBe(true);
  } finally {
    await closeAll(owner, editor);
  }
});
