import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AdminUpdateResponse } from "@gachipad/shared";
import { type Browser, expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import { ADMIN_TOKEN, BASE_URL } from "./env";
import { type User, waitForEditor } from "./helpers";

/**
 * The screenshots of README.md, taken against the end-to-end stack with made-up names and code:
 *
 *   README_SHOTS=1 pnpm --filter @gachipad/web exec playwright test readme-shots --workers=1
 *
 * Run it against a fresh database (the start page lists nearby shares) and with the e2e stack's
 * own ports (apps/web/e2e/env.ts). PNGs land in docs/images/; README_SHOTS_OUT changes the folder.
 * Without README_SHOTS=1 the file is skipped, so the regular suite never rewrites the images.
 */
const OUT =
  process.env.README_SHOTS_OUT ?? fileURLToPath(new URL("../../../docs/images/", import.meta.url));

type Theme = "dark" | "light";

const TYPES_TS = `export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

export type TodoInput = Pick<Todo, "title">;
`;

const STORE_TS = `import { randomUUID } from "node:crypto";
import type { Todo } from "./types.js";

const todos = new Map<string, Todo>();

export const store = {
  all: (): Todo[] => [...todos.values()],
  add(input: Omit<Todo, "id" | "createdAt">): Todo {
    const todo = { ...input, id: randomUUID(), createdAt: Date.now() };
    todos.set(todo.id, todo);
    return todo;
  },
  update(id: string, patch: Partial<Todo>): Todo | undefined {
    const current = todos.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    todos.set(id, next);
    return next;
  },
};
`;

const SERVER_TS = `import { createServer } from "node:http";
import { completeTodo, createTodo, listTodos } from "./routes/todos.js";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/todos") return listTodos(req, res);
  if (req.method === "POST" && url.pathname === "/todos") return createTodo(req, res);
  const done = /^\\/todos\\/([\\w-]+)\\/done$/.exec(url.pathname);
  if (req.method === "POST" && done?.[1]) return completeTodo(done[1], res);
  res.writeHead(404).end();
});

server.listen(8080, () => console.log("todo api on :8080"));
`;

const README_MD = `# Todo API

A tiny HTTP API for a classroom exercise.

| Method | Path | What it does |
|---|---|---|
| GET | /todos | open todos |
| POST | /todos | add a todo |
| POST | /todos/:id/done | mark one as done |

Run it with \`npx tsx src/server.ts\`.
`;

/** The file the screenshots focus on, in the stages the history view plays back. */
const TODOS_STAGES: string[] = [
  `import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store.js";
import type { Todo, TodoInput } from "../types.js";
`,
  `const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
`,
  `async function readBody(req: IncomingMessage): Promise<TodoInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
`,
  `export async function listTodos(_req: IncomingMessage, res: ServerResponse) {
  json(res, 200, store.all());
}
`,
  `export async function listTodos(_req: IncomingMessage, res: ServerResponse) {
  const open = store.all().filter((todo) => !todo.done);
  json(res, 200, { count: open.length, items: open });
}
`,
  `export async function createTodo(req: IncomingMessage, res: ServerResponse) {
  const input = await readBody(req);
  const todo: Todo = store.add({ title: input.title, done: false });
  json(res, 201, todo);
}
`,
  `export async function createTodo(req: IncomingMessage, res: ServerResponse) {
  const input = await readBody(req);
  if (!input.title?.trim()) {
    return json(res, 400, { error: "title is required" });
  }
  const todo: Todo = store.add({ title: input.title.trim(), done: false });
  json(res, 201, todo);
}
`,
  `export async function completeTodo(id: string, res: ServerResponse) {
  const todo = store.update(id, { done: true });
  if (!todo) return json(res, 404, { error: "not found" });
  json(res, 200, todo);
}
`,
];

/** Stage `n` (1-based) is everything written up to that point; the last one is the final file. */
function todosAt(n: number): string {
  const head = TODOS_STAGES[0] ?? "";
  const json = TODOS_STAGES[1] ?? "";
  const read = TODOS_STAGES[2] ?? "";
  const list = n >= 5 ? TODOS_STAGES[4] : n >= 4 ? TODOS_STAGES[3] : "";
  const create = n >= 7 ? TODOS_STAGES[6] : n >= 6 ? TODOS_STAGES[5] : "";
  const complete = n >= 8 ? (TODOS_STAGES[7] ?? "") : "";
  const parts = [head, n >= 2 ? json : "", n >= 3 ? read : "", list, create, complete];
  return parts.filter(Boolean).join("\n");
}

const TODOS_TS = todosAt(TODOS_STAGES.length);
const TODOS_PATH = "src/routes/todos.ts";

const FILES = [
  { path: "src/server.ts", content: SERVER_TS },
  { path: TODOS_PATH, content: TODOS_TS },
  { path: "src/store.ts", content: STORE_TS },
  { path: "src/types.ts", content: TYPES_TS },
  { path: "README.md", content: README_MD },
];

interface Person {
  user: User;
  /** Display name as the other people see it. */
  name: string;
}

/** A fresh browser profile with an exact display name (the e2e helper appends a suffix). */
async function person(
  browser: Browser,
  name: string,
  options: {
    theme?: Theme;
    viewport?: { width: number; height: number };
    scale?: number;
    mobile?: boolean;
  } = {},
): Promise<Person> {
  const theme = options.theme ?? "dark";
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: "en-US",
    extraHTTPHeaders: { "X-Gachipad": "1" },
    colorScheme: theme,
    // Remote name flags fade out after three seconds; with reduced motion they stay visible.
    reducedMotion: "reduce",
    viewport: options.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: options.scale ?? 1,
    isMobile: options.mobile ?? false,
    hasTouch: options.mobile ?? false,
  });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("gachipad.theme", value);
    } catch {
      // Storage may be blocked; the screenshot then follows the colour scheme of the context.
    }
  }, theme);
  const response = await context.request.patch("/api/session", { data: { name } });
  expect(response.ok()).toBe(true);
  const page = await context.newPage();
  return { user: { context, page, name }, name };
}

async function closeAll(...people: Person[]): Promise<void> {
  await Promise.all(people.map((p) => p.user.context.close()));
}

async function shot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}${name}.png`, clip });
}

async function createShare(owner: Person, title: string, files = FILES): Promise<string> {
  const response = await owner.user.context.request.post("/api/shares", { data: { title, files } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

async function openFile(page: Page, id: string, path = TODOS_PATH) {
  await page.goto(`/${id}`);
  await waitForEditor(page);
  await page.getByTestId(`tab-${path}`).click();
  await expect(page.locator(".cm-content")).toContainText("listTodos");
}

/** Puts the caret on a line of the open file; `select` extends it over that many characters or to the line end. */
async function caret(
  page: Page,
  lineText: string,
  options: { skip?: number; select?: number | "line" } = {},
) {
  await page.locator(".cm-line", { hasText: lineText }).first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < (options.skip ?? 0); i++) await page.keyboard.press("ArrowRight");
  if (options.select === undefined) {
    await page.keyboard.press("End");
    return;
  }
  if (options.select === "line") {
    await page.keyboard.press("Shift+End");
    return;
  }
  for (let i = 0; i < options.select; i++) await page.keyboard.press("Shift+ArrowRight");
}

/** Everyone in the same file with their own caret or selection; the first person is the viewer. */
async function collaborate(browser: Browser, theme: Theme, scale = 1) {
  const viewer = await person(browser, "Priya", { theme, scale });
  const id = await createShare(viewer, "Todo API");
  const others = [
    await person(browser, "민지", { theme, viewport: { width: 1280, height: 800 } }),
    await person(browser, "Alex", { theme, viewport: { width: 1280, height: 800 } }),
    await person(browser, "서준", { theme, viewport: { width: 1280, height: 800 } }),
  ];
  await openFile(viewer.user.page, id);
  for (const other of others) await openFile(other.user.page, id);
  const [minji, alex, seojun] = others;
  if (!minji || !alex || !seojun) throw new Error("missing collaborator");
  await caret(minji.user.page, "return json(res, 400", { select: "line" });
  await caret(alex.user.page, "const todo: Todo = store.add", { skip: 19, select: 9 });
  await caret(seojun.user.page, "return json(res, 404");
  await caret(viewer.user.page, "export async function createTodo");
  for (const other of others) {
    await expect(viewer.user.page.locator(".cm-remote-caret")).toHaveCount(others.length);
    await expect(viewer.user.page.getByText(other.name).first()).toBeAttached();
  }
  await viewer.user.page.waitForTimeout(700);
  return { viewer, others, id };
}

test.describe("README screenshots", () => {
  test.skip(process.env.README_SHOTS !== "1", "set README_SHOTS=1 to rewrite docs/images");
  test.describe.configure({ mode: "serial" });

  test("intro", async ({ browser }) => {
    // Shares people have open show up under "Nearby shares", so keep one open while looking.
    const owner = await person(browser, "Priya", { theme: "light" });
    const visitor = await person(browser, "Hana", { theme: "light" });
    try {
      const id = await createShare(owner, "Todo API");
      await openFile(owner.user.page, id);
      // The card's head count is published with a throttle and starts at 0: a caret move a few
      // seconds after joining brings it up to date.
      await owner.user.page.waitForTimeout(3_000);
      await owner.user.page.keyboard.press("ArrowDown");
      await owner.user.page.waitForTimeout(3_000);
      await visitor.user.page.goto("/");
      await expect(visitor.user.page.getByTestId("start-panel")).toBeVisible();
      await expect(visitor.user.page.getByText("1 person here")).toBeVisible();
      await visitor.user.page.waitForTimeout(2_500);
      await shot(visitor.user.page, "intro");
    } finally {
      await closeAll(visitor, owner);
    }
  });

  for (const theme of ["dark", "light"] as const) {
    test(`editor ${theme}`, async ({ browser }) => {
      const { viewer, others } = await collaborate(browser, theme);
      try {
        await shot(viewer.user.page, `editor-${theme}`);
      } finally {
        await closeAll(viewer, ...others);
      }
    });
  }

  test("multi-cursor close-up", async ({ browser }) => {
    const { viewer, others } = await collaborate(browser, "dark", 2);
    try {
      const box = await viewer.user.page.locator(".cm-content").boundingBox();
      if (!box) throw new Error("no editor");
      const top = await viewer.user.page
        .locator(".cm-line", { hasText: "export async function createTodo" })
        .first()
        .boundingBox();
      await shot(viewer.user.page, "multi-cursor", {
        x: box.x,
        y: Math.max(0, (top?.y ?? box.y) - 8),
        width: Math.min(box.width, 820),
        height: 345,
      });
    } finally {
      await closeAll(viewer, ...others);
    }
  });

  test("share dialog", async ({ browser }) => {
    const { viewer, others } = await collaborate(browser, "dark");
    try {
      const page = viewer.user.page;
      await page.getByTestId("share-button").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("qr")).toBeVisible();
      await expect
        .poll(() =>
          dialog.getByTestId("qr").evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      // The stack answers on localhost:<port>; an installation shows its own host name.
      await dialog.evaluate((root, host) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          node.textContent = (node.textContent ?? "").replace(location.host, host);
        }
        for (const input of root.querySelectorAll("input")) {
          input.value = input.value.replace(location.host, host);
        }
      }, "gachipad.local");
      await page.waitForTimeout(500);
      await shot(page, "share-dialog");
    } finally {
      await closeAll(viewer, ...others);
    }
  });

  test("history", async ({ browser }) => {
    const owner = await person(browser, "Priya", {
      theme: "dark",
      viewport: { width: 1440, height: 760 },
    });
    try {
      const id = await createShare(owner, "Todo API");
      const page = owner.user.page;
      // Real snapshots appear at most every 30 seconds of activity, so the timeline is served from
      // here: the editing stages of todos.ts, one minute apart.
      let fileId = "";
      const start = Date.now() - TODOS_STAGES.length * 4 * 60_000;
      await page.route(`**/api/shares/${id}/history`, (route) =>
        route.fulfill({
          json: TODOS_STAGES.map((_, i) => ({
            seq: i + 1,
            at: new Date(start + i * 4 * 60_000).toISOString(),
          })),
        }),
      );
      await page.route(`**/api/shares/${id}/history/*`, (route) => {
        const seq = Number(new URL(route.request().url()).pathname.split("/").pop());
        const doc = new Y.Doc();
        doc.transact(() => {
          const entry = new Y.Map<unknown>();
          doc.getMap<Y.Map<unknown>>("files").set(fileId, entry);
          entry.set("path", TODOS_PATH);
          entry.set("language", "typescript");
          entry.set("order", 0);
          doc.getText(`file:${fileId}`).insert(0, todosAt(seq));
        });
        const body = Buffer.from(Y.encodeStateAsUpdate(doc));
        doc.destroy();
        return route.fulfill({ contentType: "application/octet-stream", body });
      });
      await openFile(page, id);
      // The history view compares file by file: the served states must use the file's real id.
      fileId = (await page.getByTestId(`tab-${TODOS_PATH}`).getAttribute("data-file")) ?? "";
      expect(fileId).not.toBe("");
      await page.getByTestId("history-button").click();
      const view = page.getByTestId("history-view");
      await expect(view.getByTestId("diff")).toContainText("completeTodo");
      const slider = view.getByTestId("history-slider");
      await slider.focus();
      await page.keyboard.press("Home");
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
      await expect(view.getByTestId("history-label")).toHaveAttribute("data-index", "4");
      await expect(view.getByTestId("diff")).toContainText("count: open.length");
      // Playing: the next version arrives after 900 ms, so the picture is taken before that.
      await page.keyboard.press("Space");
      await expect(view.getByTestId("history-play")).toHaveAccessibleName("Pause");
      await shot(page, "history");
    } finally {
      await closeAll(owner);
    }
  });

  test("lab", async ({ browser }) => {
    test.setTimeout(180_000);
    const teacher = await person(browser, "Ms. Han", { theme: "dark" });
    const students: Person[] = [];
    try {
      const created = await teacher.user.context.request.post("/api/labs", { data: {} });
      expect(created.ok()).toBe(true);
      const lab = (await created.json()) as { id: string };
      const work: [string, string][] = [
        [
          "민지",
          "def fizzbuzz(n):\n    for i in range(1, n + 1):\n        if i % 15 == 0:\n            print('FizzBuzz')\n        elif i % 3 == 0:\n            print('Fizz')\n",
        ],
        [
          "Alex",
          "def average(values):\n    return sum(values) / len(values)\n\nprint(average([3, 5, 8]))\n",
        ],
        [
          "서준",
          "def is_palindrome(word):\n    word = word.lower()\n    return word == word[::-1]\n",
        ],
        [
          "Priya",
          "numbers = [4, 8, 15, 16, 23, 42]\nevens = [n for n in numbers if n % 2 == 0]\nprint(evens)\n",
        ],
        [
          "Hana",
          "def count_words(text):\n    counts = {}\n    for word in text.split():\n        counts[word] = counts.get(word, 0) + 1\n    return counts\n",
        ],
        [
          "Carlos",
          "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n",
        ],
        ["Yuki", "name = input('Name: ')\nprint('Hello,', name)\n"],
        [
          "Fatima",
          "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint([fib(i) for i in range(10)])\n",
        ],
      ];
      for (const [name, code] of work) {
        const student = await person(browser, name, {
          theme: "dark",
          viewport: { width: 1000, height: 700 },
        });
        students.push(student);
        const joined = await student.user.context.request.post(`/api/labs/${lab.id}/join`, {
          data: { name },
        });
        expect(joined.ok()).toBe(true);
        const { shareId } = (await joined.json()) as { shareId: string };
        await student.user.page.goto(`/${shareId}`);
        await waitForEditor(student.user.page);
        await student.user.page.locator(".cm-content").click();
        // Auto-indent and auto-close brackets would double what is typed; the code is inserted whole.
        await student.user.page.keyboard.insertText(code);
      }
      const page = teacher.user.page;
      await page.goto(`/lab/${lab.id}`);
      await expect(page.getByTestId("lab-grid")).toBeVisible();
      await expect(page.getByTestId("lab-count")).toContainText(String(work.length));
      await expect(page.getByTestId(`student-${students[0]?.name}`)).toBeVisible();
      await page.waitForTimeout(2_500);
      await shot(page, "lab", { x: 0, y: 0, width: 1440, height: 540 });
    } finally {
      await closeAll(teacher, ...students);
    }
  });

  test("admin", async ({ browser }) => {
    const admin = await person(browser, "Priya", {
      theme: "light",
      viewport: { width: 1100, height: 1080 },
    });
    try {
      const page = admin.user.page;
      const current: AdminUpdateResponse = {
        current: "1.0.0",
        latest: "1.0.0",
        url: "https://github.com/kim0040/gachipad/releases/tag/v1.0.0",
        publishedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        notes: "First public release.",
        checkedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        status: "ok",
        updateAvailable: false,
        repo: "kim0040/gachipad",
        channel: "stable",
        releasesUrl: "https://github.com/kim0040/gachipad/releases",
        updater: {
          auto: { enabled: true, at: "04:00", policy: "patch" },
          lastRun: null,
        },
      };
      await page.route("**/api/admin/update", (route) => route.fulfill({ json: current }));
      await page.goto("/admin");
      await page.getByTestId("admin-token").fill(ADMIN_TOKEN);
      await page.getByTestId("admin-login").click();
      await page.getByTestId("admin-nav-updates").click();
      await expect(page.getByTestId("update-status")).toBeVisible();
      await page.waitForTimeout(600);
      await shot(page, "admin");
    } finally {
      await closeAll(admin);
    }
  });

  test("mobile", async ({ browser }) => {
    const viewer = await person(browser, "Priya", {
      theme: "dark",
      viewport: { width: 320, height: 640 },
      scale: 2,
      mobile: true,
    });
    const minji = await person(browser, "민지", {
      theme: "dark",
      viewport: { width: 1280, height: 800 },
    });
    try {
      const id = await createShare(viewer, "Todo API");
      await openFile(viewer.user.page, id);
      await openFile(minji.user.page, id);
      await caret(minji.user.page, "res.writeHead(status", { select: "line" });
      await expect(viewer.user.page.locator(".cm-remote-caret")).toHaveCount(1);
      await viewer.user.page.waitForTimeout(700);
      await shot(viewer.user.page, "mobile");
    } finally {
      await closeAll(viewer, minji);
    }
  });
});
