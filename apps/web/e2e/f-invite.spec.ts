import { expect, test } from "@playwright/test";
import {
  closeAll,
  createShare,
  editorText,
  newUser,
  openShareDialog,
  type,
  waitForEditor,
} from "./helpers";

test("an invite sent through presence arrives as a toast and opens the share", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Sender");
  const receiver = await newUser(browser, "Receiver");
  try {
    // The receiver is on the start page: that is where presence and invites reach them.
    await receiver.page.goto("/");
    await expect(receiver.page.getByTestId("start-panel")).toBeVisible();

    const id = await createShare(owner.page);
    await type(owner.page, "invited code");
    const dialog = await openShareDialog(owner.page, "Send");
    await dialog.getByTestId("send-note").fill("look at this");
    await expect(dialog.getByTestId(`presence-${receiver.name}`)).toBeVisible({ timeout: 20_000 });
    await dialog.getByTestId(`presence-${receiver.name}`).getByRole("button").first().click();

    const toast = receiver.page.getByText(`${owner.name} sent you a share`).first();
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(receiver.page.getByText("look at this").first()).toBeVisible();

    await receiver.page.getByRole("button", { name: "Open share" }).click();
    await receiver.page.waitForURL(new RegExp(`/${id}$`));
    await waitForEditor(receiver.page);
    await expect.poll(() => editorText(receiver.page)).toContain("invited code");
  } finally {
    await closeAll(owner, receiver);
  }
});
