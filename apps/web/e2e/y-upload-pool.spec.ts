import { expect, test } from "@playwright/test";
import { closeAll, createShare, newUser, openShareDialog } from "./helpers";

for (const [locale, title] of [
  ["ko", "이 주소의 업로드 저장 한도에 도달했어요"],
  ["en", "This address has reached its upload storage limit"],
] as const) {
  test(`address upload pool refusal has a distinct ${locale} message`, async ({ browser }) => {
    const owner = await newUser(browser, "Sender");
    const receiver = await newUser(browser, "Receiver");
    try {
      await owner.context.addInitScript((language) => {
        localStorage.setItem("gachipad.locale", language);
      }, locale);
      await receiver.page.goto("/");
      await expect(receiver.page.getByTestId("start-panel")).toBeVisible();
      await createShare(owner.page);
      await owner.page.route("**/api/uploads", (route) =>
        route.fulfill({
          status: 429,
          json: { error: { code: "upload_pool_limited", message: "Address upload limit reached" } },
        }),
      );
      const dialog = await openShareDialog(owner.page);
      await dialog.getByRole("tab").nth(1).click();
      const target = dialog.getByTestId(`presence-${receiver.name}`);
      await expect(target).toBeVisible();
      const transfer = await owner.page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(["sample"], "sample.txt", { type: "text/plain" }));
        return data;
      });
      await target.dispatchEvent("drop", { dataTransfer: transfer });
      await expect(owner.page.getByText(title, { exact: true })).toBeVisible();
      await transfer.dispose();
    } finally {
      await closeAll(owner, receiver);
    }
  });
}
