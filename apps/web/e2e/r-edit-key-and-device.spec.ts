import { expect, type Page, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  newUser,
  openShareDialog,
  shareIdOf,
  type,
  type User,
  waitForEditor,
} from "./helpers";

/** Names of the offline copies (one IndexedDB database per share) this browser profile holds. */
async function copies(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases())
      .map((info) => info.name ?? "")
      .filter((name) => name.startsWith("codesh:doc:")),
  );
}

async function expectCopy(page: Page, id: string, present: boolean): Promise<void> {
  await expect
    .poll(async () => (await copies(page)).includes(`codesh:doc:${id}`), { timeout: 15_000 })
    .toBe(present);
}

async function viewOnly(owner: User, id: string): Promise<string> {
  const dialog = await openShareDialog(owner.page, "Access");
  const patched = owner.page.waitForResponse(
    (response) =>
      response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
  );
  await dialog.getByTestId("access-view").click();
  await patched;
  await dialog.getByRole("tab", { name: "Code and QR" }).click();
  await dialog.getByRole("button", { name: "Edit link" }).click();
  const editUrl = await dialog.getByTestId("share-link").inputValue();
  await closeDialog(owner.page);
  return editUrl;
}

async function openSettings(page: Page) {
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("forget-device")).toBeVisible();
}

/** A toast is the topmost layer after an action, so the first Escape may only dismiss that. */
async function closeSettings(page: Page) {
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("forget-device")).toBeHidden({ timeout: 1000 });
  }).toPass();
}

test("an edit link carries the key in the fragment, never in the query", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    const editUrl = await viewOnly(owner, id);
    expect(editUrl).toMatch(new RegExp(`/${id}#key=[^&?#]+$`));
    expect(editUrl).not.toContain("?key=");
  } finally {
    await closeAll(owner);
  }
});

test("opening an edit link scrubs the key at once and editing rights survive reload and history", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const editor = await newUser(browser, "Editor");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "base");
    const editUrl = await viewOnly(owner, id);
    const key = new URL(editUrl).hash.slice("#key=".length);

    // The key travels once, in the body of the join request. A legacy link shows it to the server
    // once, in the request for the page itself; nothing after that carries it in a URL.
    const joins: string[] = [];
    const urls: string[] = [];
    editor.page.on("request", (request) => {
      if (request.resourceType() !== "document") urls.push(request.url());
      if (request.url().includes("/join")) joins.push(request.postData() ?? "");
    });

    // A legacy link (`?key=`) with unrelated search and hash state next to it.
    await editor.page.goto(`/${id}?x=1&key=${key}#line-2`);
    await waitForEditor(editor.page);
    await expect(editor.page.getByTestId("banner-readonly")).toBeHidden();
    const here = new URL(editor.page.url());
    expect(here.search).toBe("?x=1");
    expect(here.hash).toBe("#line-2");
    expect(editor.page.url()).not.toContain(key);
    expect(joins.some((body) => body.includes(key))).toBe(true);
    expect(urls.filter((url) => url.includes(key))).toEqual([]);

    await type(editor.page, " + one");
    await expect.poll(() => editorText(owner.page)).toContain("+ one");

    // Reload: the address has no key any more and the server still knows this client may edit.
    await editor.page.reload();
    await waitForEditor(editor.page);
    await expect(editor.page.getByTestId("banner-readonly")).toBeHidden();
    await type(editor.page, " + two");
    await expect.poll(() => editorText(owner.page)).toContain("+ two");

    // Browser history: leave and come back; neither entry has the key.
    await editor.page.goto("/me");
    await editor.page.goBack();
    await waitForEditor(editor.page);
    await expect(editor.page.getByTestId("banner-readonly")).toBeHidden();
    expect(editor.page.url()).not.toContain(key);
    await editor.page.goForward();
    await editor.page.goBack();
    expect(editor.page.url()).not.toContain(key);
    const stored = await editor.page.evaluate(
      (needle) =>
        JSON.stringify([
          { ...localStorage },
          { ...sessionStorage },
          history.state,
          location.href,
        ]).includes(needle),
      key,
    );
    expect(stored).toBe(false);
  } finally {
    await closeAll(owner, editor);
  }
});

test("a fragment link works the same, also when pasted into a tab that is already open", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "base");
    const editUrl = await viewOnly(owner, id);
    const hash = new URL(editUrl).hash;

    const urls: string[] = [];
    guest.page.on("request", (request) => urls.push(request.url()));
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await expect(guest.page.getByTestId("banner-readonly")).toBeVisible();

    // Pasting a link that differs only in its fragment does not reload the page.
    await guest.page.evaluate((next) => {
      window.location.hash = next;
    }, hash);
    await expect(guest.page.getByTestId("banner-readonly")).toBeHidden();
    await expect.poll(() => new URL(guest.page.url()).hash).toBe("");
    await waitForEditor(guest.page);
    await type(guest.page, " + pasted");
    await expect.poll(() => editorText(owner.page)).toContain("+ pasted");
    const key = hash.slice("#key=".length);
    expect(urls.filter((url) => url.includes(key))).toEqual([]);
  } finally {
    await closeAll(owner, guest);
  }
});

test("'Forget on this device' deletes the offline copy in this tab and in another one", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "kept offline");
    await expectCopy(owner.page, id, true);

    const second = await owner.context.newPage();
    await second.goto(`/${id}`);
    await waitForEditor(second);
    await expect.poll(() => editorText(second)).toContain("kept offline");

    await openSettings(owner.page);
    await owner.page.getByTestId("forget-device").click();
    await expectCopy(owner.page, id, false);
    await expectCopy(second, id, false);

    // Nothing writes a new copy afterwards, and the live document keeps working.
    await closeSettings(owner.page);
    await type(owner.page, " more");
    await expect.poll(() => editorText(second)).toContain("more");
    await owner.page.waitForTimeout(1200);
    expect(await copies(owner.page)).toEqual([]);
  } finally {
    await closeAll(owner);
  }
});

test("the offline copy setting can be turned off and on", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "first");
    await expectCopy(owner.page, id, true);

    await openSettings(owner.page);
    const toggle = owner.page.getByTestId("switch-offline-copy");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expectCopy(owner.page, id, false);

    // Off: a reload does not create one either.
    await closeSettings(owner.page);
    await owner.page.reload();
    await waitForEditor(owner.page);
    await type(owner.page, " second");
    await owner.page.waitForTimeout(1200);
    expect(await copies(owner.page)).toEqual([]);

    await openSettings(owner.page);
    await owner.page.getByTestId("switch-offline-copy").click();
    await expectCopy(owner.page, id, true);
  } finally {
    await closeAll(owner);
  }
});

test("being removed deletes the offline copy", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "shared text");
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("shared text");
    await expectCopy(guest.page, id, true);

    const dialog = await openShareDialog(owner.page, "Access");
    await dialog
      .getByTestId("people-list")
      .getByRole("button", { name: `Remove: ${guest.name}` })
      .click();
    await owner.page.getByRole("button", { name: "Remove and block" }).first().click();
    await owner.page.getByTestId("confirm-kick").click();

    await expect(guest.page.getByText("You can't join this share")).toBeVisible();
    await expectCopy(guest.page, id, false);
  } finally {
    await closeAll(owner, guest);
  }
});

/** The page's session answers as a signed-in identity, as an OIDC or LDAP login would. */
async function signedInAs(user: User, name: string | null): Promise<void> {
  await user.context.route("**/api/session", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({
      response,
      json: name ? { ...body, identity: { provider: "oidc", name } } : body,
    });
  });
  await user.context.route("**/api/auth/logout", (route) => route.fulfill({ json: { ok: true } }));
}

test("signing out deletes every offline copy and edit key, in every tab", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    await signedInAs(owner, "Ada");
    const id = await createShare(owner.page);
    await type(owner.page, "private notes");
    await expectCopy(owner.page, id, true);

    const second = await owner.context.newPage();
    await second.goto(`/${id}`);
    await waitForEditor(second);

    await openSettings(owner.page);
    await owner.page.getByTestId("sign-out").click();
    await owner.page.waitForURL((url) => url.pathname === "/");
    await second.waitForURL((url) => url.pathname === "/");
    expect(await copies(owner.page)).toEqual([]);
    expect(await copies(second)).toEqual([]);
  } finally {
    await closeAll(owner);
  }
});

test("another account on the same device does not inherit the offline copies", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    await signedInAs(owner, "Ada");
    const id = await createShare(owner.page);
    await type(owner.page, "ada's text");
    await expectCopy(owner.page, id, true);

    await owner.context.unrouteAll();
    await signedInAs(owner, "Grace");
    await owner.page.goto("/");
    await expect.poll(async () => (await copies(owner.page)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await closeAll(owner);
  }
});

test("a PIN share shows no local content before the PIN is entered", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "pin protected body");
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("pin-set-input").fill("4821");
    await dialog.getByTestId("pin-set").click();
    await patched;
    await closeDialog(owner.page);

    // First visit: PIN, content, and a local copy of it.
    await guest.page.goto(`/${id}`);
    await guest.page.getByTestId("pin-input").fill("4821");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("pin protected body");
    await expectCopy(guest.page, id, true);

    // A new session (cookies gone) on the same browser profile: the copy is still on disk, but
    // nothing of it shows before the PIN is right.
    await guest.context.clearCookies();
    await guest.page.reload();
    await expect(guest.page.getByTestId("pin-input")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);
    await expect(guest.page.getByText("pin protected body")).toHaveCount(0);
    expect(await copies(guest.page)).toContain(`codesh:doc:${id}`);

    await guest.page.getByTestId("pin-input").fill("0000");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await expect(guest.page.getByText("That PIN doesn't match")).toBeVisible();
    await expect(guest.page.getByText("pin protected body")).toHaveCount(0);

    await guest.page.getByTestId("pin-input").fill("4821");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("pin protected body");
    expect(shareIdOf(guest.page)).toBe(id);
  } finally {
    await closeAll(owner, guest);
  }
});
