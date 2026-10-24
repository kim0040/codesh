import { expect, type Page, test } from "@playwright/test";
import { closeAll, newUser, type User } from "./helpers";

async function create(user: User, title: string, path = "main.py"): Promise<string> {
  const response = await user.context.request.post("/api/shares", {
    data: { title, files: [{ path, content: "print('hi')\n" }] },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function organize(page: Page, id: string) {
  await page.getByTestId(`share-${id}`).getByTestId("share-organize").click();
  const dialog = page.getByRole("dialog", { name: /Organize/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addTag(dialog: ReturnType<Page["getByRole"]>, tag: string) {
  const input = dialog.getByTestId("organize-tag-input");
  await input.fill(tag);
  await input.press("Enter");
  await expect(dialog.getByTestId("organize-tags").getByText(tag, { exact: true })).toBeVisible();
}

test("organize a share into a folder with two tags, filter by folder and tag, reload keeps it", async ({
  browser,
}) => {
  const user = await newUser(browser, "Org");
  try {
    const loops = await create(user, "Loops homework");
    const notes = await create(user, "Standup notes", "notes.md");
    await user.page.goto("/me");
    const rows = user.page.getByTestId("share-list").locator(":scope > li");
    await expect(rows).toHaveCount(2);
    // Nothing is organized yet, so there is no folder navigation.
    await expect(user.page.getByTestId("folder-nav")).toHaveCount(0);

    const dialog = await organize(user.page, loops);
    await dialog.getByTestId("organize-folder").fill("Week 1");
    await dialog.getByTestId("folder-option-create").click();
    await expect(dialog.getByTestId("organize-folder")).toHaveValue("Week 1");
    await addTag(dialog, "loops");
    await addTag(dialog, "java");
    await dialog.getByTestId("organize-save").click();
    await expect(dialog).toBeHidden();

    const row = user.page.getByTestId(`share-${loops}`);
    await expect(row.getByTestId("share-folder")).toHaveText(/Week 1/);
    await expect(row.getByTestId("share-tags")).toContainText("loops");
    await expect(row.getByTestId("share-tags")).toContainText("java");

    // Folder navigation: All (2), Week 1 (1), No folder (1).
    const nav = user.page.getByTestId("folder-nav");
    await expect(nav.getByRole("button", { name: /^All shares\s*2$/ })).toBeVisible();
    await nav.getByRole("button", { name: /^Week 1\s*1$/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(row).toBeVisible();
    await nav.getByRole("button", { name: /^No folder\s*1$/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(user.page.getByTestId(`share-${notes}`)).toBeVisible();

    // Tag filter, combined with the folder and the search.
    await nav.getByRole("button", { name: /^All shares/ }).click();
    const tags = user.page.getByTestId("tag-filter");
    await tags.getByRole("button", { name: /^java/ }).click();
    await expect(tags.getByRole("button", { name: /^java/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rows).toHaveCount(1);
    await expect(row).toBeVisible();
    await nav.getByRole("button", { name: /^No folder/ }).click();
    await expect(user.page.getByText("Nothing in this view")).toBeVisible();
    await user.page.getByRole("button", { name: "Show all shares" }).click();
    await expect(rows).toHaveCount(2);
    await nav.getByRole("button", { name: /^Week 1/ }).click();
    await user.page.getByTestId("share-search").fill("standup");
    await expect(user.page.getByText(/No shares match/)).toBeVisible();
    await user.page.getByTestId("share-search").fill("");

    // The labels are stored on the server, not in the page.
    await user.page.reload();
    await expect(rows).toHaveCount(2);
    await expect(row.getByTestId("share-folder")).toHaveText(/Week 1/);
    await expect(row.getByTestId("share-tags")).toContainText("loops");
    await expect(
      user.page.getByTestId("folder-nav").getByRole("button", { name: /^Week 1\s*1$/ }),
    ).toBeVisible();
  } finally {
    await closeAll(user);
  }
});

test("organize with the keyboard: existing folders and tags are suggested, chips are removable", async ({
  browser,
}) => {
  const user = await newUser(browser, "Keys");
  try {
    const first = await create(user, "First");
    const second = await create(user, "Second");
    const labelled = await user.context.request.put(`/api/shares/${first}/labels`, {
      data: { folder: "Week 1", tags: ["loops", "java"] },
    });
    expect(labelled.ok()).toBe(true);
    await user.page.goto("/me");
    await expect(user.page.getByTestId("share-list").locator(":scope > li")).toHaveCount(2);

    // Second share: pick the existing folder with the arrow keys, add a suggested tag.
    const dialog = await organize(user.page, second);
    const folder = dialog.getByTestId("organize-folder");
    await folder.fill("week");
    await expect(dialog.getByTestId("folder-option-folder")).toHaveText(/Week 1/);
    await folder.press("ArrowDown");
    await folder.press("Enter");
    await expect(folder).toHaveValue("Week 1");
    await dialog.getByTestId("organize-suggestions").getByRole("button", { name: "loops" }).click();
    await expect(dialog.getByTestId("organize-tags").getByText("loops")).toBeVisible();
    // Typing a folder that exists only in another case reuses the existing spelling.
    await folder.fill("WEEK 1");
    await dialog.getByTestId("organize-save").click();
    await expect(dialog).toBeHidden();
    const nav = user.page.getByTestId("folder-nav");
    await expect(nav.getByRole("button", { name: /^Week 1\s*2$/ })).toBeVisible();
    // Nothing is left without a folder, so there is no "No folder" pill to click.
    await expect(nav.getByRole("button")).toHaveCount(2);
    await expect(nav.getByRole("button", { name: /^No folder/ })).toHaveCount(0);

    // First share: a chip is removed with Delete, the last one with Backspace in the empty field.
    const again = await organize(user.page, first);
    const chip = again.getByRole("button", { name: "Remove tag java" });
    await chip.focus();
    await user.page.keyboard.press("Delete");
    await expect(chip).toHaveCount(0);
    const input = again.getByTestId("organize-tag-input");
    await input.focus();
    await input.press("Backspace");
    await expect(again.getByTestId("organize-tags")).toHaveCount(0);
    await again.getByTestId("organize-save").click();
    await expect(again).toBeHidden();
    await expect(user.page.getByTestId(`share-${first}`).getByTestId("share-tags")).toHaveCount(0);

    // Saving with a tag typed but not confirmed keeps the tag.
    const third = await organize(user.page, first);
    await third.getByTestId("organize-tag-input").fill("pending");
    await third.getByTestId("organize-save").click();
    await expect(third).toBeHidden();
    await expect(user.page.getByTestId(`share-${first}`).getByTestId("share-tags")).toContainText(
      "pending",
    );
  } finally {
    await closeAll(user);
  }
});

test("320px: my shares with folders, tags and the organize dialog fit the screen", async ({
  browser,
}) => {
  const user = await newUser(browser, "Narrow", { viewport: { width: 320, height: 700 } });
  try {
    const id = await create(user, "A rather long title that has to wrap on a very small screen");
    await user.context.request.put(`/api/shares/${id}/labels`, {
      data: {
        folder: "A folder with a very long name that needs to be cut",
        tags: ["a-tag-with-thirty-characters-xxx", "short"],
      },
    });
    await user.page.goto("/me");
    await expect(user.page.getByTestId(`share-${id}`)).toBeVisible();
    const overflow = () =>
      user.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);

    const dialog = await organize(user.page, id);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const box = await dialog.boundingBox();
    expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    await dialog.getByTestId("organize-save").scrollIntoViewIfNeeded();
    await expect(dialog.getByTestId("organize-save")).toBeVisible();
  } finally {
    await closeAll(user);
  }
});

test("Escape closes the folder list first and the dialog second, keeping the edits", async ({
  browser,
}) => {
  const user = await newUser(browser, "Esc");
  try {
    const id = await create(user, "Escape me");
    await user.context.request.put(`/api/shares/${id}/labels`, {
      data: { folder: "Week 1", tags: [] },
    });
    const other = await create(user, "Other");
    await user.page.goto("/me");
    await expect(user.page.getByTestId("share-list").locator(":scope > li")).toHaveCount(2);

    const dialog = await organize(user.page, other);
    const folder = dialog.getByTestId("organize-folder");
    await addTag(dialog, "unsaved");
    await folder.click();
    await expect(dialog.getByRole("listbox")).toBeVisible();

    await folder.press("Escape");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("organize-tags")).toContainText("unsaved");

    await folder.press("Escape");
    await expect(dialog).toBeHidden();
    // Nothing was saved by closing.
    await expect(user.page.getByTestId(`share-${other}`).getByTestId("share-tags")).toHaveCount(0);
  } finally {
    await closeAll(user);
  }
});

test("adding the tenth tag keeps the focus in the dialog, and Backspace frees a place", async ({
  browser,
}) => {
  const user = await newUser(browser, "Ten");
  try {
    const id = await create(user, "Ten tags");
    await user.page.goto("/me");
    const dialog = await organize(user.page, id);
    const input = dialog.getByTestId("organize-tag-input");
    await input.click();
    for (let i = 1; i <= 10; i++) {
      await user.page.keyboard.type(`tag${i}`);
      await user.page.keyboard.press("Enter");
    }
    await expect(dialog.getByTestId("organize-tags").locator("li")).toHaveCount(10);
    await expect(dialog.getByText("You can add up to 10 tags.")).toBeVisible();
    // The input is read-only, not disabled, so it keeps the focus.
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("readonly", "");
    await user.page.keyboard.press("Tab");
    expect(
      await user.page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null),
    ).toBe(true);
    await input.focus();
    await user.page.keyboard.press("Backspace");
    await expect(dialog.getByTestId("organize-tags").locator("li")).toHaveCount(9);
    await expect(input).not.toHaveAttribute("readonly", "");
    // Focus moves to the neighbouring chip, as it does for every removed tag.
    await expect(dialog.getByRole("button", { name: "Remove tag tag9" })).toBeFocused();
  } finally {
    await closeAll(user);
  }
});

test("a tab character gets a message that names the folder or the tag", async ({ browser }) => {
  const user = await newUser(browser, "Tab");
  try {
    const id = await create(user, "Tabs");
    await user.page.goto("/me");
    const dialog = await organize(user.page, id);

    await dialog.getByTestId("organize-tag-input").fill("a\tb");
    await dialog.getByTestId("organize-save").click();
    await expect(dialog.getByText("Tags can't contain line breaks or tabs.")).toBeVisible();
    await expect(dialog.getByText("Folder names can't contain")).toHaveCount(0);

    await dialog.getByTestId("organize-tag-input").fill("");
    await dialog.getByTestId("organize-folder").fill("x\ty");
    await dialog.getByTestId("organize-save").click();
    await expect(dialog.getByText("Folder names can't contain line breaks or tabs.")).toBeVisible();
    await expect(dialog.getByText("Folder names can have up to")).toHaveCount(0);
  } finally {
    await closeAll(user);
  }
});

test("search finds a share by its folder or tag", async ({ browser }) => {
  const user = await newUser(browser, "Search");
  try {
    const labelled = await create(user, "Plain title");
    await create(user, "Other");
    await user.context.request.put(`/api/shares/${labelled}/labels`, {
      data: { folder: "Midterm prep", tags: ["recursion"] },
    });
    await user.page.goto("/me");
    const rows = user.page.getByTestId("share-list").locator(":scope > li");
    await expect(rows).toHaveCount(2);
    await user.page.getByTestId("share-search").fill("recurs");
    await expect(rows).toHaveCount(1);
    await expect(user.page.getByTestId(`share-${labelled}`)).toBeVisible();
    await user.page.getByTestId("share-search").fill("midterm");
    await expect(rows).toHaveCount(1);
    await expect(user.page.getByTestId(`share-${labelled}`)).toBeVisible();
  } finally {
    await closeAll(user);
  }
});
