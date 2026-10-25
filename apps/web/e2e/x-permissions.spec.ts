import { expect, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  editorText,
  joinByLink,
  newUser,
  openShareDialog,
  type,
  waitForEditor,
} from "./helpers";

test("owner enables and revokes participant rename live in two contexts", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const member = await newUser(browser, "Participant");
  try {
    const id = await createShare(owner.page);
    await owner.page.getByTestId("title").fill("Original");
    await owner.page.getByTestId("title").press("Enter");
    await joinByLink(member, id);
    await waitForEditor(member.page);
    await expect(member.page.getByTestId("title")).toHaveText("Original");
    await expect(member.page.locator('input[data-testid="title"]')).toHaveCount(0);
    const denied = await member.context.request.patch(`/api/shares/${id}`, {
      data: { title: "Forged" },
    });
    expect(denied.status()).toBe(403);
    await type(member.page, "participant can edit text");
    await expect.poll(() => editorText(owner.page)).toContain("participant can edit text");
    await expect(member.page.getByTestId("add-file")).toHaveCount(0);
    await expect(member.page.getByTestId("language-button")).toBeDisabled();
    const memberDialog = await openShareDialog(member.page, "Send");
    await expect(memberDialog.getByRole("tab", { name: "Access", exact: true })).toHaveCount(0);
    await expect(memberDialog.getByTestId("broadcast-button")).toHaveCount(0);
    await closeDialog(member.page);

    const access = await openShareDialog(owner.page, "Access");
    const toggle = access.getByTestId("switch-allowParticipantRename");
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(member.page.locator('input[data-testid="title"]')).toBeVisible();
    await member.page.getByTestId("title").fill("Participant title");
    await member.page.getByTestId("title").press("Enter");
    await expect(owner.page.getByTestId("title")).toHaveValue("Participant title");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(member.page.locator('input[data-testid="title"]')).toHaveCount(0);
    await expect(member.page.getByTestId("title")).toHaveText("Participant title");
  } finally {
    await closeAll(owner, member);
  }
});

test("file and language controls follow independent toggles and lock takes precedence", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const member = await newUser(browser, "Participant");
  try {
    const id = await createShare(owner.page);
    await joinByLink(member, id);
    await waitForEditor(member.page);
    const access = await openShareDialog(owner.page, "Access");
    await access.getByTestId("switch-allowParticipantFiles").click();
    await expect(member.page.getByTestId("add-file")).toBeVisible();
    await expect(member.page.getByTestId("language-button")).toBeDisabled();
    await member.page.getByTestId("add-file").click();
    await member.page.getByTestId("file-name-input").fill("src/new.ts");
    await member.page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(owner.page.getByTestId("tab-src/new.ts")).toBeVisible();
    await access.getByTestId("switch-allowParticipantLanguage").click();
    await expect(member.page.getByTestId("language-button")).toBeEnabled();
    await access.getByTestId("switch-lock").click();
    await expect(member.page.getByTestId("banner-readonly")).toBeVisible();
    await expect(member.page.getByTestId("add-file")).toHaveCount(0);
    await expect(member.page.getByTestId("language-button")).toBeDisabled();
    await expect(owner.page.getByTestId("title")).toBeEditable();
  } finally {
    await closeAll(owner, member);
  }
});

test("a forged Yjs title update is refused and DocSession converges to the server", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const member = await newUser(browser, "Participant");
  try {
    const id = await createShare(owner.page);
    await owner.page.getByTestId("title").fill("Original");
    await owner.page.getByTestId("title").press("Enter");
    await member.page.goto("/");
    const result = await member.page.evaluate(async (shareId) => {
      const modulePath = "/src/lib/collab/session.ts";
      const { DocSession } = await import(/* @vite-ignore */ modulePath);
      const me = await (await fetch("/api/session")).json();
      const session = new DocSession({
        shareId,
        user: { clientId: me.clientId, name: me.name || "Participant", color: me.color },
        role: "edit",
        credentials: {},
        keepCopy: false,
      });
      const wait = async (condition: () => boolean) => {
        const deadline = Date.now() + 10000;
        while (!condition()) {
          if (Date.now() > deadline) throw new Error("permission resync timed out");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      try {
        await wait(
          () => session.getState().synced && session.doc.getMap("meta").get("title") === "Original",
        );
        const generation = session.getState().generation;
        session.doc.transact(() => {
          session.doc.getMap("meta").set("title", "FORGED_TITLE");
          session.doc.getText("file:main").insert(0, "my refused local text");
          session.doc.getText("file:deleted").insert(0, "my orphaned local text");
        });
        await wait(() => session.getState().generation > generation && session.getState().synced);
        const title = session.doc.getMap("meta").get("title");
        session.doc.getText("file:main").insert(0, "after refusal");
        await wait(() => session.getState().unsynced === 0);
        return {
          title,
          readOnly: session.getState().readOnly,
          saved: session.getState().unsentText.map((file: { text: string }) => file.text),
        };
      } finally {
        session.destroy();
      }
    }, id);
    expect(result).toEqual({
      title: "Original",
      readOnly: false,
      saved: expect.arrayContaining(["my refused local text", "my orphaned local text"]),
    });
    await expect(owner.page.getByTestId("title")).toHaveValue("Original");
    await expect.poll(() => editorText(owner.page)).toContain("after refusal");
  } finally {
    await closeAll(owner, member);
  }
});

test("offline text refused by a lock remains available to copy after resync", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const member = await newUser(browser, "Participant");
  try {
    const id = await createShare(owner.page);
    await joinByLink(member, id);
    await waitForEditor(member.page);
    // Offline emulation leaves existing WebSockets open in Firefox and WebKit.
    await member.page.evaluate(async (shareId) => {
      const modulePath = "/src/lib/collab/socket.ts";
      const { acquireSocket } = await import(/* @vite-ignore */ modulePath);
      const held = acquireSocket(shareId);
      held.socket.disconnect();
      held.release();
    }, id);
    await member.context.setOffline(true);
    await type(member.page, "TEXT_I_MUST_NOT_LOSE");
    expect(await editorText(owner.page)).not.toContain("TEXT_I_MUST_NOT_LOSE");
    const lock = await owner.context.request.patch(`/api/shares/${id}`, { data: { locked: true } });
    expect(lock.ok()).toBe(true);
    await member.context.setOffline(false);
    await member.page.evaluate(async (shareId) => {
      const modulePath = "/src/lib/collab/socket.ts";
      const { acquireSocket } = await import(/* @vite-ignore */ modulePath);
      const held = acquireSocket(shareId);
      await held.socket.connect();
      held.release();
    }, id);
    const dialog = member.page.getByTestId("unsent-text-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea").first()).toHaveValue(/TEXT_I_MUST_NOT_LOSE/);
    await member.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copied: string }).copied = text;
          },
        },
      });
    });
    await dialog.getByRole("button", { name: "Copy my unsent text", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Copied");
    expect(
      await member.page.evaluate(() => (window as unknown as { copied: string }).copied),
    ).toContain("TEXT_I_MUST_NOT_LOSE");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(member.page.getByTestId("unsent-text-banner")).toBeVisible();
    await expect.poll(() => editorText(owner.page)).not.toContain("TEXT_I_MUST_NOT_LOSE");
  } finally {
    await closeAll(owner, member);
  }
});
