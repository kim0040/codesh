import { expect, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  newUser,
  openShareDialog,
  type,
  waitForEditor,
} from "./helpers";

test("a share with a PIN asks for it and rejects a wrong one", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "secret body");
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("pin-set-input").fill("4821");
    await dialog.getByTestId("pin-set").click();
    await patched;
    await closeDialog(owner.page);

    await guest.page.goto(`/${id}`);
    const pin = guest.page.getByTestId("pin-input");
    await expect(pin).toBeVisible();
    // The editor and its content stay out of reach until the PIN is right.
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);

    await pin.fill("0000");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await expect(guest.page.getByText("That PIN doesn't match")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);

    await pin.fill("4821");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("secret body");
  } finally {
    await closeAll(owner, guest);
  }
});
