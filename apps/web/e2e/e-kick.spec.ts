import { expect, test } from "@playwright/test";
import {
  closeAll,
  createShare,
  joinByLink,
  newUser,
  openShareDialog,
  waitForEditor,
} from "./helpers";

test("the owner removes a participant, who lands on the removed screen", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await joinByLink(guest, id);
    await waitForEditor(guest.page);

    const dialog = await openShareDialog(owner.page, "Access");
    const people = dialog.getByTestId("people-list");
    await expect(people).toContainText(guest.name);
    await people.getByRole("button", { name: `Remove: ${guest.name}` }).click();
    await owner.page.getByTestId("confirm-kick").click();

    await expect(guest.page.getByText("You were removed from this share")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);
    await expect(people).not.toContainText(guest.name);

    // A plain removal is not a ban: the code or link still works.
    await joinByLink(guest, id);
    await waitForEditor(guest.page);
  } finally {
    await closeAll(owner, guest);
  }
});

test("a blocked participant cannot come back", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await joinByLink(guest, id);
    await waitForEditor(guest.page);

    const dialog = await openShareDialog(owner.page, "Access");
    const people = dialog.getByTestId("people-list");
    await people.getByRole("button", { name: `Remove: ${guest.name}` }).click();
    await owner.page.getByRole("button", { name: "Remove and block" }).first().click();
    await owner.page.getByTestId("confirm-kick").click();

    await expect(guest.page.getByText("You can't join this share")).toBeVisible();
    await joinByLink(guest, id);
    await expect(guest.page.getByText("You can't join this share")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);
  } finally {
    await closeAll(owner, guest);
  }
});
