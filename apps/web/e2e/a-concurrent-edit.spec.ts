import { expect, type Page, test } from "@playwright/test";
import {
  closeAll,
  createShare,
  editorText,
  joinByLink,
  newUser,
  type User,
  waitForEditor,
} from "./helpers";

/** Routes the page's collab socket through a switch, so a test can cut and restore it. */
async function withSocketSwitch(user: User) {
  let offline = false;
  const open = new Set<{ close: () => void }>();
  await user.page.routeWebSocket(/\/collab/, (ws) => {
    if (offline) {
      ws.close();
      return;
    }
    ws.connectToServer();
    open.add(ws);
  });
  return {
    async goOffline() {
      offline = true;
      await user.context.setOffline(true);
      for (const ws of open) ws.close();
      open.clear();
    },
    async goOnline() {
      offline = false;
      await user.context.setOffline(false);
    },
  };
}

/** Random typing: short bursts, caret jumps and line breaks, as three people editing would. */
async function typeRandomly(page: Page, ms: number, seed: string) {
  const deadline = Date.now() + ms;
  await page.locator(".cm-content").click();
  let n = 0;
  while (Date.now() < deadline) {
    const roll = Math.random();
    if (roll < 0.1) await page.keyboard.press("Enter");
    else if (roll < 0.25) await page.keyboard.press(Math.random() < 0.5 ? "ArrowLeft" : "ArrowUp");
    else if (roll < 0.3) await page.keyboard.press("Home");
    else if (roll < 0.34) await page.keyboard.press("Backspace");
    else await page.keyboard.type(`${seed}${n++}`, { delay: 8 + Math.random() * 30 });
    await page.waitForTimeout(10 + Math.random() * 60);
  }
}

test("three contexts edit one share at once, one of them offline for 3 s, and converge", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const alice = await newUser(browser, "Alice");
  const bob = await newUser(browser, "Bob");
  const cara = await newUser(browser, "Cara");
  try {
    const id = await createShare(alice.page);
    await joinByLink(bob, id);
    await joinByLink(cara, id);
    await waitForEditor(bob.page);
    await waitForEditor(cara.page);
    const socket = await withSocketSwitch(cara);
    // The switch only catches sockets opened after it was installed.
    await cara.page.reload();
    await waitForEditor(cara.page);

    const typing = Promise.all([
      typeRandomly(alice.page, 10_000, "a"),
      typeRandomly(bob.page, 10_000, "b"),
      typeRandomly(cara.page, 10_000, "c"),
    ]);
    await alice.page.waitForTimeout(3_000);
    await socket.goOffline();
    await expect(cara.page.getByTestId("connection-status")).not.toHaveAttribute(
      "data-status",
      "connected",
    );
    await alice.page.waitForTimeout(3_000);
    await socket.goOnline();
    await typing;

    await expect(cara.page.getByTestId("connection-status")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 20_000 },
    );
    await expect
      .poll(
        async () => {
          const [a, b, c] = await Promise.all([
            editorText(alice.page),
            editorText(bob.page),
            editorText(cara.page),
          ]);
          return a === b && b === c ? a.length : -1;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(20);

    const text = await editorText(alice.page);
    // Everything each person typed while offline or online survived the merge.
    for (const seed of ["a", "b", "c"]) expect(text).toContain(`${seed}0`);
  } finally {
    await closeAll(alice, bob, cara);
  }
});
