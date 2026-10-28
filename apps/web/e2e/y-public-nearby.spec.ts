import { expect, test } from "@playwright/test";

for (const [net, visible] of [
  ["client:public-visitor", false],
  ["Configured room", true],
] as const) {
  test(`nearby list ${visible ? "stays visible for rooms" : "is hidden for private public groups"}`, async ({
    page,
  }) => {
    let served = false;
    await page.route("**/api/session", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), net } });
      served = true;
    });
    await page.goto("/");
    await expect(page.getByTestId("start-panel")).toBeVisible();
    await expect.poll(() => served).toBe(true);
    if (visible) await expect(page.getByTestId("nearby")).toBeVisible();
    else await expect(page.getByTestId("nearby")).toHaveCount(0);
  });
}
