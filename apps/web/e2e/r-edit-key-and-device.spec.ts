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
  // Signing out reloads the page; read again once the new document is there.
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(async () =>
        (await indexedDB.databases())
          .map((info) => info.name ?? "")
          .filter((name) => name.startsWith("codesh:doc:")),
      );
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("context was destroyed")) throw error;
      await page.waitForLoadState("load");
    }
  }
}

async function expectCopy(page: Page, id: string, present: boolean): Promise<void> {
  await expect
    .poll(async () => (await copies(page)).includes(`codesh:doc:${id}`), { timeout: 15_000 })
    .toBe(present);
}

/** Answers the editor's one-time question: keep offline copies on this device. */
async function keepCopies(page: Page): Promise<void> {
  await page.getByTestId("device-choice-keep").click();
  await expect(page.getByTestId("device-choice")).toBeHidden();
}

/** Records every IndexedDB open and delete of the page, from before the app starts. */
async function logIndexedDb(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __idb: string[] }).__idb = log;
    const open = indexedDB.open.bind(indexedDB);
    const remove = indexedDB.deleteDatabase.bind(indexedDB);
    indexedDB.open = (name: string, version?: number) => {
      log.push(`open ${name}`);
      return open(name, version);
    };
    indexedDB.deleteDatabase = (name: string) => {
      log.push(`delete ${name}`);
      return remove(name);
    };
  });
}

async function idbLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __idb: string[] }).__idb);
}

async function setPin(owner: User, id: string, pin: string): Promise<void> {
  const dialog = await openShareDialog(owner.page, "Access");
  const patched = owner.page.waitForResponse(
    (response) =>
      response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
  );
  await dialog.getByTestId("pin-set-input").fill(pin);
  await dialog.getByTestId("pin-set").click();
  await patched;
  await closeDialog(owner.page);
}

async function clientIdOf(user: User): Promise<string> {
  const response = await user.context.request.get("/api/session");
  return ((await response.json()) as { clientId: string }).clientId;
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
    const referers: Promise<string | null>[] = [];
    let coldLoad = true;
    editor.page.on("request", (request) => {
      if (request.resourceType() !== "document") urls.push(request.url());
      if (request.url().includes("/join")) joins.push(request.postData() ?? "");
      // Every request of the cold load, also those before the app scrubbed the address.
      if (coldLoad) referers.push(request.headerValue("referer").catch(() => null));
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
    coldLoad = false;
    const sent = await Promise.all(referers);
    expect(sent.length).toBeGreaterThan(3);
    expect(sent.filter((referer) => referer?.includes(key))).toEqual([]);

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

test("a clean profile writes no offline copy before the device question is answered", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  const upgraded = await newUser(browser, "Upgraded");
  try {
    await logIndexedDb(owner.page);
    const id = await createShare(owner.page);
    await type(owner.page, "not yet");
    await expect(owner.page.getByTestId("device-choice")).toBeVisible();

    // A visitor, and a browser whose settings are from before the question (the old switch on).
    await logIndexedDb(guest.page);
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await upgraded.page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("codesh.prefs", JSON.stringify({ offlineCopy: true }));
      }
    });
    await logIndexedDb(upgraded.page);
    await upgraded.page.goto(`/${id}`);
    await waitForEditor(upgraded.page);
    await expect(upgraded.page.getByTestId("device-choice")).toBeVisible();

    await owner.page.waitForTimeout(1200);
    for (const page of [owner.page, guest.page, upgraded.page]) {
      expect((await idbLog(page)).filter((entry) => entry.startsWith("open codesh:doc:"))).toEqual(
        [],
      );
      expect(await copies(page)).toEqual([]);
    }

    // Offline, without a copy the banner does not promise one.
    await guest.context.setOffline(true);
    await expect(guest.page.getByTestId("banner-offline")).toContainText("only in this tab");
    await guest.context.setOffline(false);

    // The answer is kept: yes writes the copy, the question does not come back.
    await keepCopies(owner.page);
    await expectCopy(owner.page, id, true);
    await owner.page.reload();
    await waitForEditor(owner.page);
    await expect(owner.page.getByTestId("device-choice")).toBeHidden();
    await owner.context.setOffline(true);
    await expect(owner.page.getByTestId("banner-offline")).toContainText("kept on this device");
    await owner.context.setOffline(false);

    // No is kept too, and changes in Settings.
    await guest.page.getByTestId("device-choice-skip").click();
    await guest.page.reload();
    await waitForEditor(guest.page);
    await expect(guest.page.getByTestId("device-choice")).toBeHidden();
    await openSettings(guest.page);
    await expect(guest.page.getByTestId("switch-offline-copy")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(await copies(guest.page)).toEqual([]);
  } finally {
    await closeAll(owner, guest, upgraded);
  }
});

test("'Forget on this device' closes the share in every tab and keeps no copy until asked again", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "kept offline");
    const editUrl = await viewOnly(owner, id);
    const key = new URL(editUrl).hash.slice("#key=".length);

    // A guest who came with the edit key.
    await guest.page.goto(editUrl);
    await waitForEditor(guest.page);
    await keepCopies(guest.page);
    await expectCopy(guest.page, id, true);
    const second = await guest.context.newPage();
    await second.goto(`/${id}`);
    await waitForEditor(second);
    await expect.poll(() => editorText(second)).toContain("kept offline");

    const joins: string[] = [];
    for (const page of [guest.page, second]) {
      page.on("request", (request) => {
        if (request.url().includes("/join")) joins.push(request.postData() ?? "");
      });
    }
    await openSettings(guest.page);
    await guest.page.getByTestId("forget-device").click();
    await guest.page.waitForURL((url) => url.pathname === "/");
    await second.waitForURL((url) => url.pathname === "/");
    await expect(guest.page.getByText("Forgotten on this device", { exact: true })).toBeVisible();
    await expectCopy(guest.page, id, false);

    // The documents are gone: nothing joins again on its own.
    await guest.page.waitForTimeout(2000);
    expect(joins).toEqual([]);

    // Back to the share, reload, another tab: no copy and no key until the user asks for one.
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await guest.page.reload();
    await waitForEditor(guest.page);
    await second.goto(`/${id}`);
    await waitForEditor(second);
    await type(guest.page, " more");
    await guest.page.waitForTimeout(1200);
    expect(await copies(guest.page)).toEqual([]);
    expect(joins.filter((body) => body.includes(key))).toEqual([]);

    await openSettings(guest.page);
    const toggle = guest.page.getByTestId("switch-offline-copy");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expectCopy(guest.page, id, true);
  } finally {
    await closeAll(owner, guest);
  }
});

test("the offline copy setting can be turned off and on", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    await keepCopies(owner.page);
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

test("turning copies off deletes those of shares no tab has open", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    const first = await createShare(owner.page);
    await keepCopies(owner.page);
    await type(owner.page, "first share");
    await expectCopy(owner.page, first, true);
    const second = await createShare(owner.page);
    await type(owner.page, "second share");
    await expectCopy(owner.page, second, true);
    expect(await copies(owner.page)).toHaveLength(2);

    await openSettings(owner.page);
    await owner.page.getByTestId("switch-offline-copy").click();
    await expect.poll(() => copies(owner.page), { timeout: 15_000 }).toEqual([]);
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
    await keepCopies(guest.page);
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

test("a ban while the tab was closed deletes the copy on the next visit", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "shared text");
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await keepCopies(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("shared text");
    await expectCopy(guest.page, id, true);
    await guest.page.goto("/");

    const banned = await owner.context.request.post(`/api/shares/${id}/kick`, {
      data: { clientId: await clientIdOf(guest), ban: true },
    });
    expect(banned.ok()).toBe(true);

    await guest.page.goto(`/${id}`);
    await expect(guest.page.getByText("You can't join this share")).toBeVisible();
    await expectCopy(guest.page, id, false);
  } finally {
    await closeAll(owner, guest);
  }
});

test("a PIN asked for anew while editing ends the session and deletes the copy", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest");
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "before the pin");
    await guest.page.goto(`/${id}`);
    await waitForEditor(guest.page);
    await keepCopies(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("before the pin");
    await expectCopy(guest.page, id, true);

    await setPin(owner, id, "4821");
    await expect(guest.page.getByTestId("pin-input")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);
    await expectCopy(guest.page, id, false);

    // The right PIN lets the guest in again, from the server state.
    await guest.page.getByTestId("pin-input").fill("4821");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await waitForEditor(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("before the pin");
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
    await keepCopies(owner.page);
    await type(owner.page, "private notes");
    await expectCopy(owner.page, id, true);

    const second = await owner.context.newPage();
    await second.goto(`/${id}`);
    await waitForEditor(second);

    await openSettings(owner.page);
    await owner.page.getByTestId("sign-out").click();
    await owner.page.waitForURL((url) => url.pathname === "/");
    await second.waitForURL((url) => url.pathname === "/");
    // Both pages load the start page again; the list is read once they settled.
    await expect.poll(() => copies(owner.page)).toEqual([]);
    await expect.poll(() => copies(second)).toEqual([]);
  } finally {
    await closeAll(owner);
  }
});

for (const databases of ["missing", "rejected"] as const) {
  test(`signing out deletes closed shares' copies when indexedDB.databases() is ${databases}`, async ({
    browser,
  }) => {
    const owner = await newUser(browser, "Owner");
    try {
      await signedInAs(owner, "Ada");
      const first = await createShare(owner.page);
      await keepCopies(owner.page);
      await type(owner.page, "first share");
      await expectCopy(owner.page, first, true);

      // Another page of this profile, where the browser cannot list its databases.
      const page = await owner.context.newPage();
      await page.addInitScript((mode) => {
        Object.defineProperty(indexedDB, "databases", {
          configurable: true,
          value: mode === "missing" ? undefined : () => Promise.reject(new Error("SecurityError")),
        });
      }, databases);
      await owner.page.close();
      await page.goto("/");
      await page.getByTestId("new-share").click();
      await page.waitForURL((url) => url.pathname !== "/");
      await waitForEditor(page);
      await type(page, "second share");

      await openSettings(page);
      await page.getByTestId("sign-out").click();
      await page.waitForURL((url) => url.pathname === "/");
      await page.waitForLoadState("load");
      await expect(page.getByText("Some data could not be deleted")).toHaveCount(0);
      const check = await owner.context.newPage();
      await check.goto("/");
      await expect.poll(() => copies(check), { timeout: 15_000 }).toEqual([]);
    } finally {
      await closeAll(owner);
    }
  });
}

test("another account on the same device does not inherit the offline copies", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    await signedInAs(owner, "Ada");
    const id = await createShare(owner.page);
    await keepCopies(owner.page);
    await type(owner.page, "ada's text");
    await expectCopy(owner.page, id, true);

    // A login always starts a new session (apps/api routes/auth.ts).
    await owner.context.unrouteAll();
    await owner.context.clearCookies();
    await signedInAs(owner, "Grace");
    await owner.page.goto("/");
    await expect.poll(async () => (await copies(owner.page)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await closeAll(owner);
  }
});

test("two accounts with the same name and no email are different accounts", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    await signedInAs(owner, "Ada");
    const id = await createShare(owner.page);
    await keepCopies(owner.page);
    await type(owner.page, "first ada");
    await expectCopy(owner.page, id, true);
    const other = await owner.context.newPage();
    await other.goto("/");

    // Another login with the same display name: a new session, opened straight on the share.
    await owner.context.clearCookies();
    await logIndexedDb(owner.page);
    await owner.page.goto(`/${id}`);
    await other.waitForURL((url) => url.pathname === "/");
    await expect
      .poll(async () => (await idbLog(owner.page)).filter((entry) => entry.endsWith(id)), {
        timeout: 15_000,
      })
      .toContain(`delete codesh:doc:${id}`);
    const log = (await idbLog(owner.page)).filter((entry) => entry.endsWith(id));
    // Deleted before anything of this session could open it.
    expect(log[0]).toBe(`delete codesh:doc:${id}`);
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
    await setPin(owner, id, "4821");

    // First visit: PIN, content, and a local copy of it.
    await guest.page.goto(`/${id}`);
    await guest.page.getByTestId("pin-input").fill("4821");
    await guest.page.getByRole("button", { name: "Unlock" }).click();
    await waitForEditor(guest.page);
    await keepCopies(guest.page);
    await expect.poll(() => editorText(guest.page)).toContain("pin protected body");
    await expectCopy(guest.page, id, true);

    // A new session (cookies gone) on the same browser profile is another client: the copy goes
    // before anything of it could show, and the PIN is asked for again.
    await guest.context.clearCookies();
    await guest.page.reload();
    await expect(guest.page.getByTestId("pin-input")).toBeVisible();
    await expect(guest.page.locator(".cm-content")).toHaveCount(0);
    await expect(guest.page.getByText("pin protected body")).toHaveCount(0);
    await expectCopy(guest.page, id, false);

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
