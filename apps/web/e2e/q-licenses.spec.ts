import { expect, test } from "@playwright/test";
import { closeAll, createShare, newUser } from "./helpers";

const LICENSES = "/THIRD-PARTY-LICENSES.txt";

test("the open-source licenses link is in the intro footer and in the settings", async ({
  browser,
}) => {
  const user = await newUser(browser, "Lic");
  try {
    await user.page.goto("/");
    const footerLink = user.page.locator("footer").getByRole("link", {
      name: /Open-source licenses/,
    });
    await expect(footerLink).toHaveAttribute("href", LICENSES);
    await expect(footerLink).toHaveAttribute("target", "_blank");

    await createShare(user.page);
    await user.page.getByTestId("settings-button").click();
    const settingsLink = user.page.getByRole("dialog").getByRole("link", {
      name: /Open-source licenses/,
    });
    await settingsLink.scrollIntoViewIfNeeded();
    await expect(settingsLink).toHaveAttribute("href", LICENSES);
  } finally {
    await closeAll(user);
  }
});
