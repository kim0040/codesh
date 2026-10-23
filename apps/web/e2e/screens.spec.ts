import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { closeAll, newUser, type User, waitForEditor } from "./helpers";

/** Review screenshots: `.box-out/screens/*.png` at the repository root, pulled back by scripts/box. */
const SCREENS = fileURLToPath(new URL("../../../.box-out/screens/", import.meta.url));

const SERVER_TS = `import { createServer } from "node:http";

interface Visitor {
  name: string;
  joinedAt: Date;
}

const visitors = new Map<string, Visitor>();

export function greet(name: string): string {
  const key = name.trim().toLowerCase();
  if (!visitors.has(key)) {
    visitors.set(key, { name, joinedAt: new Date() });
  }
  return \`Hello, \${name}! You are visitor #\${visitors.size}.\`;
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(greet(url.searchParams.get("name") ?? "friend"));
}).listen(8080);
`;

async function shot(page: Page, name: string) {
  await mkdir(SCREENS, { recursive: true });
  await page.screenshot({ path: `${SCREENS}${name}.png` });
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

async function createWithFiles(user: User, title: string): Promise<string> {
  const response = await user.context.request.post("/api/shares", {
    data: {
      title,
      files: [
        { path: "server.ts", content: SERVER_TS },
        { path: "README.md", content: `# ${title}\n\nA tiny greeting server.\n` },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function openEditor(user: User, id: string) {
  await user.page.goto(`/${id}`);
  await waitForEditor(user.page);
  await expect(user.page.locator(".cm-content")).toContainText("greet");
}

const VARIANTS = [
  { theme: "dark", width: 1440, height: 900 },
  { theme: "light", width: 1440, height: 900 },
  { theme: "dark", width: 375, height: 812 },
  { theme: "light", width: 375, height: 812 },
] as const;

for (const variant of VARIANTS) {
  test(`editor ${variant.theme} ${variant.width}`, async ({ browser }) => {
    const owner = await newUser(browser, "Maya", {
      colorScheme: variant.theme,
      viewport: { width: variant.width, height: variant.height },
    });
    let peer: User | null = null;
    try {
      await setTheme(owner, variant.theme);
      const id = await createWithFiles(owner, "Greeting server");
      await openEditor(owner, id);
      if (variant.width > 600) {
        peer = await newUser(browser, "Jun", {
          colorScheme: variant.theme,
          viewport: { width: 1200, height: 800 },
        });
        await openEditor(peer, id);
        await peer.page.locator(".cm-line", { hasText: "visitors.set" }).click();
        await peer.page.keyboard.press("End");
        await expect(owner.page.locator(".cm-remote-caret").first()).toBeAttached();
        await owner.page.waitForTimeout(1_200);
      }
      await owner.page.locator(".cm-line", { hasText: "greet" }).first().click();
      await shot(owner.page, `editor-${variant.theme}-${variant.width}`);
    } finally {
      await closeAll(...(peer ? [owner, peer] : [owner]));
    }
  });
}

test("share dialog, projector mode and settings", async ({ browser }) => {
  const owner = await newUser(browser, "Maya", {
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  const guest = await newUser(browser, "Jun");
  try {
    await setTheme(owner, "dark");
    const id = await createWithFiles(owner, "Greeting server");
    await openEditor(owner, id);
    await guest.page.goto("/");
    await expect(guest.page.getByTestId("start-panel")).toBeVisible();

    await owner.page.getByTestId("share-button").click();
    const dialog = owner.page.getByRole("dialog");
    await expect(dialog.getByTestId("qr")).toBeVisible();
    await expect
      .poll(() =>
        dialog.getByTestId("qr").evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(owner.page, "share-dialog");

    await dialog.getByTestId("projector-button").click();
    await expect(owner.page.getByTestId("projector")).toBeVisible();
    await owner.page.waitForTimeout(500);
    await shot(owner.page, "projector-mode");
    await owner.page.getByTestId("projector-exit").click();
    await expect(owner.page.getByTestId("projector")).toBeHidden();
    await owner.page.keyboard.press("Escape");

    await owner.page.getByTestId("settings-button").click();
    await expect(owner.page.getByRole("dialog")).toBeVisible();
    await owner.page.waitForTimeout(300);
    await shot(owner.page, "settings");
  } finally {
    await closeAll(owner, guest);
  }
});

test("my shares", async ({ browser }) => {
  const owner = await newUser(browser, "Maya", {
    colorScheme: "light",
    viewport: { width: 1440, height: 900 },
  });
  try {
    await setTheme(owner, "light");
    for (const title of ["Greeting server", "Algorithms homework", "Standup notes"]) {
      await createWithFiles(owner, title);
    }
    await owner.page.goto("/me");
    await expect(owner.page.getByTestId("share-list")).toBeVisible();
    await expect(owner.page.getByTestId("share-list").locator("li")).toHaveCount(3);
    await shot(owner.page, "my-shares");
  } finally {
    await closeAll(owner);
  }
});

test("lab grid", async ({ browser }) => {
  test.setTimeout(120_000);
  const teacher = await newUser(browser, "Prof", {
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  const students: User[] = [];
  try {
    await setTheme(teacher, "dark");
    const created = await teacher.context.request.post("/api/labs", { data: {} });
    expect(created.ok()).toBe(true);
    const lab = (await created.json()) as { id: string };

    const names = ["Ara", "Bo", "Chen", "Dina", "Eli", "Fay", "Gus", "Hana"];
    for (const [index, name] of names.entries()) {
      const student = await newUser(browser, name);
      students.push(student);
      const joined = await student.context.request.post(`/api/labs/${lab.id}/join`, {
        data: { name: student.name },
      });
      expect(joined.ok()).toBe(true);
      const { shareId } = (await joined.json()) as { shareId: string };
      await student.page.goto(`/${shareId}`);
      await waitForEditor(student.page);
      await student.page.locator(".cm-content").click();
      await student.page.keyboard.type(
        index % 3 === 0
          ? "def solve(n):\n    return n * 2\n"
          : index % 3 === 1
            ? "function solve(n) {\n  return n + 1;\n}\n"
            : "// still thinking",
        { delay: 5 },
      );
    }

    await teacher.page.goto(`/lab/${lab.id}`);
    await expect(teacher.page.getByTestId("lab-teacher")).toBeVisible();
    await expect(teacher.page.getByTestId("lab-grid")).toBeVisible();
    await expect(teacher.page.getByTestId("lab-count")).toContainText(String(names.length));
    await expect(teacher.page.getByTestId(`student-${students[0]?.name}`)).toBeVisible();
    await teacher.page.waitForTimeout(2_000);
    await shot(teacher.page, "lab-grid");
  } finally {
    await closeAll(teacher, ...students);
  }
});
