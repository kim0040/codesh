import { expect, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  newUser,
  openShareDialog,
  shareIdOf,
  type,
  waitForEditor,
} from "./helpers";

test("a second context joins with the 6-digit code and sees the text", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "const hello = 1;");

    const dialog = await openShareDialog(owner.page);
    const code = ((await dialog.getByTestId("join-code").textContent()) ?? "").replace(/\D/g, "");
    expect(code).toMatch(/^\d{6}$/);
    await closeDialog(owner.page);

    await guest.page.goto("/");
    await guest.page.getByRole("group", { name: /6/ }).locator("input").first().click();
    await guest.page.keyboard.type(code, { delay: 30 });
    await guest.page.waitForURL(new RegExp(`/${id}$`));
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("const hello = 1;");

    // Both directions work.
    await type(guest.page, " // hi");
    await expect.poll(() => editorText(owner.page)).toContain("// hi");
    expect(shareIdOf(guest.page)).toBe(id);
  } finally {
    await closeAll(owner, guest);
  }
});

test("a code that does not exist says so and keeps the user on the start page", async ({
  browser,
}) => {
  const user = await newUser(browser, "Lost");
  try {
    await user.page.goto("/");
    await user.page.getByRole("group", { name: /6/ }).locator("input").first().click();
    await user.page.keyboard.type("912345", { delay: 30 });
    await expect(user.page.getByRole("alert")).toContainText("doesn't exist");
    expect(new URL(user.page.url()).pathname).toBe("/");
  } finally {
    await closeAll(user);
  }
});
