import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN_TOKEN } from "./env";
import { closeAll, newUser, type User } from "./helpers";

/** Review screenshots of folders, tags and templates: `.box-out/organize/*.png`, at the repository root. */
const OUT = fileURLToPath(new URL("../../../.box-out/organize/", import.meta.url));

async function shot(page: Page, name: string, fullPage = false) {
  await mkdir(OUT, { recursive: true });
  // Let the dialog and list animations settle so the picture shows the final state.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage });
}

async function setTheme(user: User, theme: "dark" | "light") {
  await user.context.addInitScript((value) => {
    try {
      localStorage.setItem("codesh.theme", value);
    } catch {
      // Storage may be blocked; the screenshot then uses the system scheme.
    }
  }, theme);
}

const SHARES = [
  { title: "Loops homework", path: "Main.java", folder: "Week 1", tags: ["loops", "java"] },
  {
    title: "Recursion practice",
    path: "solve.py",
    folder: "Week 1",
    tags: ["python", "recursion"],
  },
  { title: "Binary trees", path: "tree.ts", folder: "Week 2", tags: ["homework", "trees"] },
  { title: "Group project API", path: "server.go", folder: "Project", tags: ["go", "api"] },
  { title: "Standup notes", path: "notes.md", folder: null, tags: ["notes"] },
  { title: "Scratch pad", path: "scratch.js", folder: null, tags: [] },
] as const;

async function seed(user: User) {
  for (const entry of SHARES) {
    const created = await user.context.request.post("/api/shares", {
      data: {
        title: entry.title,
        files: [{ path: entry.path, content: "// a few lines\nconsole.log('hi');\n" }],
      },
    });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    if (entry.folder || entry.tags.length > 0) {
      const labelled = await user.context.request.put(`/api/shares/${id}/labels`, {
        data: { folder: entry.folder, tags: entry.tags },
      });
      expect(labelled.ok()).toBe(true);
    }
  }
}

const MY_SHARES = [
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 320, height: 700 },
  { theme: "light", width: 320, height: 700 },
] as const;

for (const variant of MY_SHARES) {
  test(`my shares with folders and tags ${variant.theme} ${variant.width}`, async ({ browser }) => {
    const user = await newUser(browser, "Maya", {
      colorScheme: variant.theme,
      viewport: { width: variant.width, height: variant.height },
    });
    try {
      await setTheme(user, variant.theme);
      await seed(user);
      await user.page.goto("/me");
      await expect(user.page.getByTestId("share-list").locator(":scope > li")).toHaveCount(
        SHARES.length,
      );
      await expect(user.page.getByTestId("folder-nav")).toBeVisible();
      await shot(user.page, `my-shares-${variant.theme}-${variant.width}`, variant.width < 600);

      // The same list narrowed to one folder and one tag.
      await user.page
        .getByTestId("folder-nav")
        .getByRole("button", { name: /^Week 1/ })
        .click();
      await user.page.getByTestId("tag-filter").getByRole("button", { name: /^java/ }).click();
      await expect(user.page.getByTestId("share-list").locator(":scope > li")).toHaveCount(1);
      await shot(
        user.page,
        `my-shares-filtered-${variant.theme}-${variant.width}`,
        variant.width < 600,
      );

      await user.page.getByTestId("share-organize").first().click();
      await expect(user.page.getByRole("dialog", { name: /Organize/ })).toBeVisible();
      await user.page.getByTestId("organize-folder").click();
      await shot(user.page, `organize-dialog-${variant.theme}-${variant.width}`);
    } finally {
      await closeAll(user);
    }
  });
}

const PICKER = [
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 375, height: 812 },
  { theme: "light", width: 375, height: 812 },
] as const;

for (const variant of PICKER) {
  test(`template picker ${variant.theme} ${variant.width}`, async ({ browser }) => {
    const user = await newUser(browser, "Maya", {
      colorScheme: variant.theme,
      viewport: { width: variant.width, height: variant.height },
    });
    try {
      await setTheme(user, variant.theme);
      await user.page.goto("/");
      await user.page.getByTestId("new-from-template").click();
      const picker = user.page.getByRole("dialog", { name: "Start from a template" });
      await expect(picker.getByTestId("template-builtin-java")).toBeVisible();
      await picker.getByTestId("template-builtin-java").click();
      await expect(picker.getByTestId("template-files")).toContainText("Main.java");
      await shot(user.page, `template-picker-${variant.theme}-${variant.width}`);
    } finally {
      await closeAll(user);
    }
  });
}

test("admin templates editor", async ({ browser }) => {
  const admin = await newUser(browser, "Admin", {
    colorScheme: "dark",
    viewport: { width: 1440, height: 1000 },
  });
  const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  try {
    await setTheme(admin, "dark");
    // Settings are global and k-templates.spec.ts edits them in parallel, so this screenshot test
    // only answers the admin page's read with its own templates and never writes them.
    const current = await admin.context.request.get("/api/admin/settings", { headers: bearer });
    const settings = (await current.json()) as object;
    await admin.page.route("**/api/admin/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        json: {
          ...settings,
          templates: [
            {
              id: "org-service",
              name: "Team service skeleton",
              language: "go",
              description: "Our HTTP service with health check and tests.",
              files: [
                { path: "cmd/server/main.go", content: "package main\n\nfunc main() {}\n" },
                { path: "internal/health/health.go", content: "package health\n" },
                { path: "README.md", content: "# Service\n" },
              ],
            },
            {
              id: "org-lab",
              name: "Lab exercise",
              language: "python",
              description: "",
              files: [{ path: "exercise.py", content: "def solve():\n    pass\n" }],
            },
          ],
        },
      });
    });

    await admin.page.goto("/admin");
    await admin.page.getByTestId("admin-token").fill(ADMIN_TOKEN);
    await admin.page.getByTestId("admin-login").click();
    // The console opens on the overview; templates and the contact are under Settings.
    await admin.page.getByRole("tab", { name: "Settings", exact: true }).click();
    const editor = admin.page.getByTestId("templates-editor");
    await expect(editor.getByText("Team service skeleton")).toBeVisible();
    await editor.scrollIntoViewIfNeeded();
    await shot(admin.page, "admin-templates-list");

    await editor.getByRole("button", { name: "Edit: Team service skeleton" }).click();
    const dialog = admin.page.getByRole("dialog", { name: "Edit template" });
    await expect(dialog.getByTestId("template-name")).toHaveValue("Team service skeleton");
    await shot(admin.page, "admin-templates-editor");
  } finally {
    await closeAll(admin);
  }
});
