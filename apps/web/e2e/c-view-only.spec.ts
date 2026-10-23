import { expect, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  joinByLink,
  newUser,
  openShareDialog,
  type,
  waitForEditor,
} from "./helpers";

test("the view link cannot type, the edit link can", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const viewer = await newUser(browser, "Viewer");
  const editor = await newUser(browser, "Editor");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "locked text");

    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("access-view").click();
    await patched;
    await dialog.getByRole("tab", { name: "Code and QR" }).click();
    const viewUrl = await dialog.getByTestId("share-link").inputValue();
    await dialog.getByRole("button", { name: "Edit link" }).click();
    const editUrl = await dialog.getByTestId("share-link").inputValue();
    expect(viewUrl).not.toContain("key=");
    expect(editUrl).toContain("key=");
    await closeDialog(owner.page);

    await viewer.page.goto(new URL(viewUrl).pathname);
    await waitForEditor(viewer.page);
    await expect(viewer.page.getByTestId("banner-readonly")).toBeVisible();
    await expect.poll(() => editorText(viewer.page)).toContain("locked text");
    await expect(viewer.page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
    await viewer.page.locator(".cm-content").click();
    await viewer.page.keyboard.type("INTRUDER");
    await owner.page.waitForTimeout(800);
    expect(await editorText(owner.page)).not.toContain("INTRUDER");
    expect(await editorText(viewer.page)).not.toContain("INTRUDER");

    const url = new URL(editUrl);
    await editor.page.goto(`${url.pathname}${url.search}`);
    await waitForEditor(editor.page);
    await expect(editor.page.getByTestId("banner-readonly")).toBeHidden();
    await type(editor.page, " + edited");
    await expect.poll(() => editorText(owner.page)).toContain("+ edited");
    await expect.poll(() => editorText(viewer.page)).toContain("+ edited");
  } finally {
    await closeAll(owner, viewer, editor);
  }
});

test("a view-only participant cannot reach it by joining without the key", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("access-view").click();
    await patched;
    await closeDialog(owner.page);

    await joinByLink(guest, id);
    await waitForEditor(guest.page);
    await expect(guest.page.getByTestId("banner-readonly")).toBeVisible();
  } finally {
    await closeAll(owner, guest);
  }
});
