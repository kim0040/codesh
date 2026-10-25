import { readFile } from "node:fs/promises";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { ADMIN_TOKEN } from "./env";
import { closeAll, createShare, newUser, type, waitForEditor } from "./helpers";

test("client diagnostics export contains real failures without document text, PIN or edit key", async ({
  browser,
}) => {
  const owner = await newUser(browser, "DiagOwner");
  try {
    const page = owner.page;
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/collab/, (socket) => {
      socket.connectToServer();
      sockets.push(socket);
    });
    const id = await createShare(page);
    const content = "PRIVATE_DOCUMENT_TEXT_DIAG_72e1";
    const pin = "827496";
    await type(page, content);
    const shareResponse = await owner.context.request.patch(`/api/shares/${id}`, {
      data: { access: { pin } },
    });
    expect(shareResponse.ok()).toBe(true);
    const share = await shareResponse.json();
    const key = share.access.editKey as string;
    expect(key).toBeTruthy();
    // Put the real edit key through the same fragment-capture path as an invited user.
    await page.goto(`/${id}#key=${key}`);
    await waitForEditor(page);
    await page.route(`**/api/shares/${id}/join`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: `${content} ${pin} ${key}` } },
      }),
    );
    await owner.context.setOffline(true);
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "offline");
    await owner.context.setOffline(false);
    await sockets.at(-1)?.close({ code: 1012, reason: "network" });
    // A failed real collab rejoin uses api.ts and records a redacted route and status.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem("codesh.diagnostics.v1");
          return raw
            ? JSON.parse(raw).some(
                (e: { kind: string; details: { status?: number } }) =>
                  e.kind === "api_failure" && e.details.status === 503,
              )
            : false;
        }),
      )
      .toBe(true);
    await page.unroute(`**/api/shares/${id}/join`);
    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("diagnostics-section")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByTestId("diagnostics-export").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^codesh-diagnostics-[\w.-]+-\d{8}-\d{4}\.json$/);
    const path = await file.path();
    expect(path).toBeTruthy();
    const raw = await readFile(path as string, "utf8");
    const data = JSON.parse(raw);
    expect(data.format).toBe(1);
    expect(data.environment.appVersion).toBeTruthy();
    expect(data.events.some((e: { kind: string }) => e.kind === "api_failure")).toBe(true);
    expect(data.events.some((e: { kind: string }) => e.kind === "disconnect")).toBe(true);
    for (const value of [content, pin, key, id, "#key=", "827496"])
      expect(raw).not.toContain(value);
    expect(raw).toContain("/api/shares/:id/join");
    await page.getByTestId("diagnostics-clear").click();
    await expect(page.getByTestId("diagnostics-section")).toContainText("0 event groups");
    await page.getByTestId("diagnostics-enabled").click();
    await page.reload();
    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("diagnostics-enabled")).toHaveAttribute("aria-checked", "false");
  } finally {
    await closeAll(owner);
  }
});

test("admin operations tabs show live data and fit 320px; tokens stay out of query cache and exports", async ({
  browser,
}) => {
  const admin = await newUser(browser, "DiagAdmin", { viewport: { width: 320, height: 800 } });
  try {
    const page = admin.page;
    const id = await createShare(page);
    await admin.context.request.get("/api/admin/security", {
      headers: { Authorization: "Bearer WRONG-DIAG-ATTEMPT" },
    });
    await page.goto("/admin");
    await page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await page.getByTestId("admin-login").click();
    await expect(page.getByTestId("admin-overview")).toContainText("Live shares");
    for (const [tab, testId, text] of [
      ["shares", "admin-shares", id],
      ["diagnostics", "admin-diagnostics", "admin_login_failed"],
      ["security", "admin-security", "Failed admin logins"],
    ]) {
      await page.getByTestId(`admin-nav-${tab}`).click();
      await expect(page.getByTestId(testId as string)).toContainText(text as string);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
    await page.getByTestId("admin-nav-shares").click();
    const ownRow = page.getByTestId("admin-shares").getByRole("listitem").filter({ hasText: id });
    await ownRow.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Apply this action");
    await page.getByRole("dialog").getByRole("button", { name: "Lock", exact: true }).click();
    await expect(ownRow.getByRole("button", { name: "Lock", exact: true })).toBeDisabled();
    expect(
      await page.evaluate(async (token) => {
        const path = "/src/lib/query.ts";
        const { queryClient } = await import(path);
        return queryClient
          .getQueryCache()
          .getAll()
          .some((query: { queryKey: unknown }) => JSON.stringify(query.queryKey).includes(token));
      }, ADMIN_TOKEN),
    ).toBe(false);
    await page.getByTestId("admin-nav-templates").click();
    await expect(page.getByTestId("admin-templates")).toContainText("Code templates");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("set-ttl")).toBeVisible();
    await page.getByRole("tab", { name: "People", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await page.getByRole("tab", { name: "Audit log", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await page.getByRole("tab", { name: "Status", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await page.getByTestId("admin-nav-updates").click();
    await expect(page.getByTestId("admin-updates")).toBeVisible();
    await page.getByTestId("admin-nav-diagnostics").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("server-diagnostics-export").click();
    const file = await download;
    const path = await file.path();
    const raw = await readFile(path as string, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ format: 1, config: { ADMIN_TOKEN_SET: true } });
    expect(raw).not.toContain(ADMIN_TOKEN);
    expect(raw).not.toContain("WRONG-DIAG-ATTEMPT");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("codesh.admin"))).toBeNull();
    expect(
      await page.evaluate(async () => {
        const path = "/src/lib/query.ts";
        const { queryClient } = await import(path);
        return queryClient
          .getQueryCache()
          .getAll()
          .some((query: { queryKey: unknown[] }) => query.queryKey[0] === "admin");
      }),
    ).toBe(false);
    await expect(page.getByTestId("admin-token")).toBeVisible();
  } finally {
    await closeAll(admin);
  }
});
