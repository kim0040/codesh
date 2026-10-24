import type { AdminUpdateResponse } from "@codesh/shared";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN_TOKEN } from "./env";
import { closeAll, createShare, newUser, type } from "./helpers";

/** What the API answers once GitHub knows a newer release; the E2E stack itself has UPDATE_CHECK=off. */
const available: AdminUpdateResponse = {
  current: "1.0.0",
  latest: "1.2.0",
  url: "https://github.com/kim0040/codesh/releases/tag/v1.2.0",
  publishedAt: "2026-10-20T09:30:00.000Z",
  notes: "## Added\n- Faster sync <img src=x onerror=alert(1)>\n\n## Fixed\n- **Bold** stays text",
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  status: "ok",
  updateAvailable: true,
  repo: "kim0040/codesh",
  channel: "stable",
  releasesUrl: "https://github.com/kim0040/codesh/releases",
  updater: {
    auto: { enabled: true, at: "04:00", policy: "patch" },
    lastRun: {
      at: new Date(Date.now() - 3600_000).toISOString(),
      result: "updated",
      from: "0.9.0",
      to: "1.0.0",
      message: null,
    },
  },
};

async function signIn(page: Page) {
  await page.goto("/admin");
  await page.getByTestId("admin-token").fill(ADMIN_TOKEN);
  await page.getByTestId("admin-login").click();
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("admin: a newer release shows as a badge and an Updates section with plain-text notes", async ({
  browser,
}) => {
  const admin = await newUser(browser, "Admin", { viewport: { width: 320, height: 800 } });
  try {
    const page = admin.page;
    await page.route("**/api/admin/update", (route) => route.fulfill({ json: available }));
    // "Check now" finds GitHub unreachable this time; the last known release stays.
    await page.route("**/api/admin/update/check", (route) =>
      route.fulfill({
        json: { ...available, status: "unreachable", checkedAt: new Date().toISOString() },
      }),
    );
    await signIn(page);
    await expect(page.getByTestId("admin-update-badge")).toHaveText("New version");
    await page.getByTestId("admin-nav-updates").click();

    const panel = page.getByTestId("admin-updates");
    await expect(panel.getByTestId("update-status")).toContainText("Version 1.2.0 is available");
    await expect(panel).toContainText("Installed version");
    await expect(panel).toContainText("1.0.0");
    await expect(panel).toContainText("October 20, 2026");
    await expect(panel).toContainText("Last checked 5 minutes ago");

    const notes = panel.getByTestId("update-notes");
    await expect(notes).toContainText("<img src=x onerror=alert(1)>");
    await expect(notes).toContainText("**Bold** stays text");
    await expect(notes.locator("img, b, strong, h2")).toHaveCount(0);

    const link = panel.getByRole("link", { name: "Release page (opens in a new tab)" }).first();
    await expect(link).toHaveAttribute("href", available.url ?? "");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);

    await expect(panel.getByText("./update.sh", { exact: true })).toBeVisible();
    await expect(panel.getByText("./upgrade.sh codesh-1.2.0-linux-amd64.tar.gz")).toBeVisible();
    await expect(panel.getByTestId("update-auto")).toContainText(
      "On: every day around 04:00, bug-fix releases only",
    );
    await expect(panel.getByTestId("update-auto")).toContainText("Updated 0.9.0 → 1.0.0");
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await panel.getByTestId("update-check").click();
    await expect(panel.getByTestId("update-status")).toContainText(
      "Can't check: no internet connection",
    );
    await expect(panel).toContainText("1.2.0");
  } finally {
    await closeAll(admin);
  }
});

test("admin: the real API reports the check as off (UPDATE_CHECK=off) and asks nobody", async ({
  browser,
}) => {
  const admin = await newUser(browser, "Admin");
  try {
    await signIn(admin.page);
    await expect(admin.page.getByTestId("admin-update-badge")).toHaveCount(0);
    await admin.page.getByTestId("admin-nav-updates").click();
    const panel = admin.page.getByTestId("admin-updates");
    await expect(panel.getByTestId("update-status")).toContainText("The update check is off");
    await expect(panel.getByTestId("update-check")).toBeDisabled();
    const version = await admin.context.request.get("/api/version");
    expect(await version.json()).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  } finally {
    await closeAll(admin);
  }
});

test("client: an updated server offers a reload that never happens by itself while editing", async ({
  browser,
}) => {
  const user = await newUser(browser, "Writer");
  try {
    const page = user.page;
    // Same version as this build: no prompt.
    await page.goto("/");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("update-prompt")).toHaveCount(0);

    await page.route("**/api/version", (route) => route.fulfill({ json: { version: "99.0.0" } }));
    await createShare(page);
    const prompt = page.getByTestId("update-prompt");
    await expect(prompt).toContainText("A new version is available");
    await expect(prompt.getByRole("button", { name: "Reload" })).toBeVisible();

    // Editing goes on: no reload while typing, the page keeps its state.
    await page.evaluate(() => {
      (window as unknown as { marker: number }).marker = 1;
    });
    await page.locator(".cm-content").click();
    await type(page, "still editing");
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    await expect(page.locator(".cm-content")).toContainText("still editing");

    await prompt.getByRole("button", { name: "Later" }).click();
    await expect(prompt).toHaveCount(0);

    // A fresh load still sees the other version and offers the reload; the button reloads.
    await page.reload();
    await expect(prompt).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { marker: number }).marker = 2;
    });
    await Promise.all([
      page.waitForEvent("load"),
      prompt.getByRole("button", { name: "Reload" }).click(),
    ]);
    expect(
      await page.evaluate(() => (window as unknown as { marker?: number }).marker),
    ).toBeUndefined();
    await expect(page.locator(".cm-content")).toContainText("still editing");
  } finally {
    await closeAll(user);
  }
});
