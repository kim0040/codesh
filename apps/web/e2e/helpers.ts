import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { BASE_URL } from "./env";

export interface User {
  context: BrowserContext;
  page: Page;
  name: string;
}

let counter = 0;

/** A fresh browser profile (own cookie, own IndexedDB) with a fixed display name. */
export async function newUser(
  browser: Browser,
  label: string,
  options: { colorScheme?: "dark" | "light"; viewport?: { width: number; height: number } } = {},
): Promise<User> {
  // Names are unique per run so presence lists never collide between parallel specs.
  const name = `${label}${Date.now().toString(36).slice(-4)}${counter++}`;
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: "en-US",
    // The API's CSRF guard: the app sends it itself, direct API calls from specs need it too.
    extraHTTPHeaders: { "X-Gachipad": "1" },
    ...options,
  });
  const response = await context.request.patch("/api/session", { data: { name } });
  expect(response.ok()).toBe(true);
  const page = await context.newPage();
  return { context, page, name };
}

export async function closeAll(...users: User[]): Promise<void> {
  await Promise.all(users.map((user) => user.context.close()));
}

/** Creates a share from the start panel and waits until the editor is usable. */
export async function createShare(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("new-share").click();
  await page.waitForURL((url) => url.pathname !== "/");
  await waitForEditor(page);
  return shareIdOf(page);
}

export function shareIdOf(page: Page): string {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).pop();
  if (!id) throw new Error(`no share id in ${page.url()}`);
  return id;
}

export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
}

/** The document text; lines are concatenated, which is enough to compare two editors. */
export async function editorText(page: Page): Promise<string> {
  return (await page.locator(".cm-content").textContent()) ?? "";
}

export async function type(page: Page, text: string, delay = 15): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.type(text, { delay });
}

export async function openShareDialog(page: Page, tab?: "Code and QR" | "Send" | "Access") {
  await page.getByTestId("share-button").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (tab) await dialog.getByRole("tab", { name: tab }).click();
  return dialog;
}

export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
}

/** Joins a share the way a second person would: by its link. */
export async function joinByLink(user: User, id: string, search = ""): Promise<void> {
  await user.page.goto(`/${id}${search}`);
}
