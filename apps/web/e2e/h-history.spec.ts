import { expect, test } from "@playwright/test";
import { closeAll, createShare, editorText, newUser, type, waitForEditor } from "./helpers";

// The collab server writes a history snapshot at most every 30 s, so this spec waits for real.
test("the owner restores an earlier version from the history", async ({ browser }) => {
  test.setTimeout(150_000);
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "version one");

    const snapshots = () =>
      owner.page.request
        .get(`/api/shares/${id}/history`)
        .then((response) => response.json() as Promise<unknown[]>);
    await expect
      .poll(async () => (await snapshots()).length, { timeout: 60_000, intervals: [2_000] })
      .toBeGreaterThanOrEqual(1);

    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.press("ControlOrMeta+a");
    await owner.page.keyboard.type("version two", { delay: 15 });
    await expect
      .poll(async () => (await snapshots()).length, { timeout: 70_000, intervals: [2_000] })
      .toBeGreaterThanOrEqual(2);

    await owner.page.getByTestId("history-button").click();
    const view = owner.page.getByTestId("history-view");
    await expect(view).toBeVisible();
    const slider = view.getByTestId("history-slider");
    await slider.focus();
    await owner.page.keyboard.press("Home");
    await expect(view.getByTestId("diff")).toContainText("version one");

    await view.getByTestId("history-restore").click();
    await owner.page.getByTestId("history-restore-confirm").click();

    // The restore arrives through the normal sync, not as a local edit.
    await expect(owner.page.getByTestId("history-view")).toBeHidden();
    await waitForEditor(owner.page);
    await expect.poll(() => editorText(owner.page), { timeout: 15_000 }).toContain("version one");
    expect(await editorText(owner.page)).not.toContain("version two");
  } finally {
    await closeAll(owner);
  }
});
