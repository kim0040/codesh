import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN, BASE_URL } from "./env";
import { closeAll, createShare, newUser } from "./helpers";

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
    await expect(page.getByTestId("admin-http-warning")).toHaveCount(0);
    await page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await page.getByTestId("admin-token").press("Enter");
    await expect(page.getByTestId("admin-overview").getByRole("status")).toBeVisible();
    release();
    await expect(page.getByTestId("admin-overview")).toContainText("Couldn't load this page");
    await page.screenshot({ path: testInfo.outputPath("overview-error-320.png"), fullPage: true });
    await page.unroute("**/api/admin/overview");
    await page.route("**/api/admin/overview", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        json: { ...data, health: { mongo: false, valkey: false, collab: "unknown" } },
      });
    });
    const retry = page.getByTestId("admin-overview").getByRole("button", { name: "Try again" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("admin-overview")).toContainText("Live shares");
    await expect(page.getByText("mongo: Down", { exact: true })).toBeVisible();
    await expect(page.getByText("valkey: Down", { exact: true })).toBeVisible();
    await expect(page.getByText("collab: Unknown", { exact: true })).toBeVisible();
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

test("admin shares offer named lock, unlock and delete actions", async ({ browser }) => {
  const admin = await newUser(browser, "Admin");
  try {
    const id = await createShare(admin.page);
    const title = `Action target ${id}`;
    await admin.context.request.patch(`/api/shares/${id}`, { data: { title } });
    await admin.page.goto("/admin");
    await admin.page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await admin.page.getByTestId("admin-token").press("Enter");
    await admin.page.getByTestId("admin-nav-shares").click();
    for (const action of ["Lock", "Unlock"] as const) {
      await admin.page.getByRole("button", { name: `${action}: ${title}`, exact: true }).click();
      await admin.page
        .getByRole("dialog")
        .getByRole("button", { name: action, exact: true })
        .click();
      await expect(admin.page.getByRole("dialog")).toHaveCount(0);
    }
    await expect(
      admin.page.getByRole("button", { name: `Delete: ${title}`, exact: true }),
    ).toBeVisible();
    await expect(admin.page.getByRole("button", { name: /Expire/ })).toHaveCount(0);
  } finally {
    await closeAll(admin);
  }
});

test("plain HTTP on a non-loopback host warns before and after login", async ({ browser }) => {
  const admin = await newUser(browser, "Admin");
  try {
    await admin.page.route("http://admin.codesh.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events") {
        await route.fulfill({ contentType: "text/event-stream", body: "" });
        return;
      }
      await route.fulfill({
        response: await route.fetch({
          url: `${BASE_URL}${url.pathname}${url.search}`,
          headers: { ...route.request().headers(), host: new URL(BASE_URL).host },
        }),
      });
    });
    await admin.page.goto("http://admin.codesh.test/admin");
    const warning = admin.page.getByTestId("admin-http-warning");
    await expect(warning).toContainText("Your admin token travels in clear text");
    await expect(warning).toContainText("HTTPS");
    await expect(warning).toContainText("ADMIN_ALLOW_CIDR");
    await admin.page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await admin.page.getByTestId("admin-token").press("Enter");
    await expect(admin.page.getByTestId("admin-nav-shares")).toBeVisible();
    await expect(warning).toBeVisible();
  } finally {
    await closeAll(admin);
  }
});
