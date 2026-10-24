import { expect, type Page, test } from "@playwright/test";
import {
  closeAll,
  closeDialog,
  createShare,
  newUser,
  openShareDialog,
  shareIdOf,
  type,
  waitForEditor,
} from "./helpers";

const NARROW = { width: 320, height: 700 };

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectInsideViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, testId).not.toBeNull();
  expect(box?.x ?? -1, `${testId} left edge`).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${testId} right edge`).toBeLessThanOrEqual(
    NARROW.width,
  );
}

test("320px: the PIN gate and the admin sign-in fit, Unlock stays reachable", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  const guest = await newUser(browser, "Guest", { viewport: NARROW });
  try {
    const created = await owner.context.request.post("/api/shares", {
      data: { title: "locked", files: [{ path: "a.ts", content: "const a = 1;\n" }] },
    });
    const { id } = (await created.json()) as { id: string };
    const patched = await owner.context.request.patch(`/api/shares/${id}`, {
      data: { access: { pin: "4821" } },
    });
    expect(patched.ok()).toBe(true);

    await guest.page.goto(`/${id}`);
    await expect(guest.page.getByTestId("pin-input")).toBeVisible();
    expect(await overflow(guest.page)).toBeLessThanOrEqual(0);
    const unlock = guest.page.getByRole("button", { name: "Unlock" });
    await expect(unlock).toBeVisible();
    const box = await unlock.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(NARROW.width);

    // An empty submit explains itself instead of sitting behind a disabled button.
    await expect(unlock).toBeEnabled();
    await unlock.click();
    await expect(guest.page.getByRole("alert")).toContainText("Enter the PIN");

    await guest.page.goto("/admin");
    await expect(guest.page.getByTestId("admin-token")).toBeVisible();
    expect(await overflow(guest.page)).toBeLessThanOrEqual(0);
    await expectInsideViewport(guest.page, "admin-login");
  } finally {
    await closeAll(owner, guest);
  }
});

test("320px: the editor fits, phone-hidden actions are hidden and the hint stays off filled files", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner", { viewport: NARROW });
  try {
    const created = await owner.context.request.post("/api/shares", {
      data: {
        title: "A very long share title that cannot fit",
        files: [{ path: "main.ts", content: "const answer = 42;\n".repeat(20) }],
      },
    });
    const { id } = (await created.json()) as { id: string };
    await owner.page.goto(`/${id}`);
    await waitForEditor(owner.page);

    expect(await overflow(owner.page)).toBeLessThanOrEqual(0);
    await expectInsideViewport(owner.page, "menu-button");
    await expectInsideViewport(owner.page, "share-button");
    await expect(owner.page.getByTestId("history-button")).toBeHidden();
    await expect(owner.page.getByTestId("settings-button")).toBeHidden();
    // The file already has content, so the "only one here" card must not cover it.
    await expect(owner.page.getByText("You're the only one here")).toBeHidden();
  } finally {
    await closeAll(owner);
  }
});

test("320px: a view-only share keeps its Menu button on screen", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  const viewer = await newUser(browser, "Viewer", { viewport: NARROW });
  try {
    const id = await createShare(owner.page);
    await type(owner.page, "read me");
    const dialog = await openShareDialog(owner.page, "Access");
    const patched = owner.page.waitForResponse(
      (response) =>
        response.url().includes(`/api/shares/${id}`) && response.request().method() === "PATCH",
    );
    await dialog.getByTestId("access-view").click();
    await patched;
    await dialog.getByRole("tab", { name: "Code and QR" }).click();
    const viewUrl = await dialog.getByTestId("share-link").inputValue();
    await closeDialog(owner.page);

    await viewer.page.goto(new URL(viewUrl).pathname);
    await waitForEditor(viewer.page);
    expect(await overflow(viewer.page)).toBeLessThanOrEqual(0);
    await expectInsideViewport(viewer.page, "menu-button");
  } finally {
    await closeAll(owner, viewer);
  }
});

test("the light-theme intro call to action meets 4.5:1", async ({ browser }) => {
  const user = await newUser(browser, "Light", { colorScheme: "light" });
  try {
    await user.context.addInitScript(() => {
      try {
        localStorage.setItem("codesh.theme", "light");
      } catch {
        // The scheme preference above still applies.
      }
    });
    await user.page.goto("/");
    const cta = user.page.getByTestId("new-share");
    await expect(cta).toBeVisible();
    const ratio = await cta.evaluate((element) => {
      // Resolve any CSS colour syntax (oklch, color-mix) to sRGB through a canvas pixel.
      const toRgb = (value: string): [number, number, number] => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no 2d context");
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      };
      const luminance = ([r, g, b]: [number, number, number]) => {
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const style = getComputedStyle(element);
      const a = luminance(toRgb(style.color));
      const b = luminance(toRgb(style.backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // The reset no longer strips the button's own weight.
    await expect(cta).toHaveCSS("font-weight", /^(500|600|700)$/);
  } finally {
    await closeAll(user);
  }
});

test("closing the share dialog returns focus to where it opened from", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    await createShare(owner.page);
    const share = owner.page.getByTestId("share-button");
    await share.focus();
    await owner.page.keyboard.press("Enter");
    await expect(owner.page.getByRole("dialog")).toBeVisible();
    await owner.page.keyboard.press("Escape");
    await expect(owner.page.getByRole("dialog")).toBeHidden();
    await expect(share).toBeFocused();
  } finally {
    await closeAll(owner);
  }
});

test("the editor names its keyboard exit and the file tabs are a plain group", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    const id = await createShare(owner.page);
    expect(shareIdOf(owner.page)).toBe(id);
    const content = owner.page.locator(".cm-content");
    const describedBy = await content.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(owner.page.locator(`#${describedBy}`)).toContainText("Esc, then Tab");
    // No tablist: its children include the per-file menu buttons.
    await expect(owner.page.getByRole("tablist")).toHaveCount(0);
    // The title field is not the page's only heading.
    await expect(owner.page.getByRole("heading", { level: 1 })).toHaveCount(1);
  } finally {
    await closeAll(owner);
  }
});
