import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN } from "./env";
import { closeAll, newUser } from "./helpers";

test("operator panels expose loading, empty, error and keyboard retry states at 320px", async ({
  browser,
}, testInfo) => {
  const admin = await newUser(browser, "DiagStates", { viewport: { width: 320, height: 800 } });
  try {
    const page = admin.page;
    await page.emulateMedia({ reducedMotion: "reduce" });
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/admin/overview", async (route) => {
      await pending;
      await route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "unavailable" } },
      });
    });
    await page.route("**/api/admin/shares?**", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/admin/diagnostics", (route) => route.fulfill({ json: [] }));
    await page.goto("/admin");
    await page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await page.getByTestId("admin-token").press("Enter");
    await expect(page.getByTestId("admin-overview").getByRole("status")).toBeVisible();
    release();
    await expect(page.getByTestId("admin-overview")).toContainText("Couldn't load this page");
    await page.screenshot({ path: testInfo.outputPath("overview-error-320.png"), fullPage: true });
    await page.unroute("**/api/admin/overview");
    const retry = page.getByTestId("admin-overview").getByRole("button", { name: "Try again" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-overview")).toContainText("Live shares");
    await page.screenshot({ path: testInfo.outputPath("overview-320.png"), fullPage: true });
    await page.getByTestId("admin-nav-overview").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("admin-nav-shares")).toBeFocused();
    await expect(page.getByTestId("admin-shares")).toContainText("No shares found");
    await page.getByTestId("admin-nav-diagnostics").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-diagnostics")).toContainText("No diagnostic events");
    await page.screenshot({
      path: testInfo.outputPath("diagnostics-empty-320.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.route("**/api/admin/security", (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "unavailable" } },
      }),
    );
    await page.getByTestId("admin-nav-security").click();
    await expect(page.getByTestId("admin-security")).toContainText("Couldn't load this page");
    await page.unroute("**/api/admin/security");
    await page.getByTestId("admin-security").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("admin-security")).toContainText("Rotate the token");
    await page.screenshot({ path: testInfo.outputPath("security-320.png"), fullPage: true });
  } finally {
    await closeAll(admin);
  }
});
