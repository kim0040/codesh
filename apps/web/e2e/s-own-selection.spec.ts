import { expect, type Locator, type Page, test } from "@playwright/test";
import { closeAll, createShare, joinByLink, newUser, waitForEditor } from "./helpers";

/** Share of pixels in `box` that are painted in the colour of `selector` (text glyphs cover the rest). */
async function paintedShare(page: Page, box: Locator, selector: string): Promise<number> {
  const rect = await box.boundingBox();
  if (!rect) throw new Error("no bounding box");
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(
    async ({ data, selector }) => {
      const probe = document.querySelector(selector);
      if (!probe) throw new Error(`missing ${selector}`);
      const [r, g, b] = (getComputedStyle(probe).backgroundColor.match(/[\d.]+/g) ?? []).map(
        Number,
      );
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let hits = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const near =
          Math.abs((pixels[i] ?? 0) - (r ?? 0)) <= 6 &&
          Math.abs((pixels[i + 1] ?? 0) - (g ?? 0)) <= 6 &&
          Math.abs((pixels[i + 2] ?? 0) - (b ?? 0)) <= 6;
        if (near) hits++;
      }
      return hits / (pixels.length / 4);
    },
    { data: png.toString("base64"), selector },
  );
}

test("your own drag selection is painted on the caret's line, Hangul included", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Selecting");
  const guest = await newUser(browser, "Watching");
  try {
    const id = await createShare(owner.page);
    await owner.page.getByTestId("device-choice-skip").click();
    await owner.page.locator(".cm-content").click();
    await owner.page.keyboard.insertText("가나다라마바사 hello world\nsecond line");
    const first = owner.page.locator(".cm-line").first();
    const line = await first.boundingBox();
    if (!line) throw new Error("no first line");
    await owner.page.mouse.move(line.x + 2, line.y + line.height / 2);
    await owner.page.mouse.down();
    await owner.page.mouse.move(line.x + 140, line.y + line.height / 2, { steps: 6 });
    await owner.page.mouse.up();

    const selection = owner.page.locator(".cm-selectionBackground").first();
    await expect(selection).toBeVisible();
    expect(await paintedShare(owner.page, selection, ".cm-selectionBackground")).toBeGreaterThan(
      0.3,
    );
    await expect(first).not.toHaveClass(/cm-activeLine/);

    // The other participant sees the same range on their screen.
    await joinByLink(guest, id);
    await waitForEditor(guest.page);
    await expect(guest.page.locator(".cm-remote-selection")).not.toHaveCount(0);

    // A collapsed caret highlights its line again, with a translucent colour.
    await owner.page.keyboard.press("End");
    await expect(first).toHaveClass(/cm-activeLine/);
    const background = await first.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toMatch(/^rgba\(.+,\s*0?\.\d+\)$/);
  } finally {
    await closeAll(owner, guest);
  }
});
