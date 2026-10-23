import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { closeAll, createShare, editorText, newUser, type } from "./helpers";

test("add files, switch between them and download everything as a zip", async ({ browser }) => {
  const owner = await newUser(browser, "Owner");
  try {
    await createShare(owner.page);
    await type(owner.page, "print('main')");

    for (const [name, body] of [
      ["util.py", "def helper(): pass"],
      ["notes.md", "# Notes"],
    ] as const) {
      await owner.page.getByTestId("add-file").click();
      await owner.page.getByTestId("file-name-input").fill(name);
      await owner.page.keyboard.press("Enter");
      await expect(owner.page.getByTestId(`tab-${name}`)).toBeVisible();
      await type(owner.page, body);
    }

    await owner.page.getByTestId("tab-util.py").click();
    await expect.poll(() => editorText(owner.page)).toContain("def helper(): pass");
    await expect(owner.page.getByTestId("language-button")).toContainText(/python/i);

    await owner.page.getByTestId("menu-button").click();
    const downloadPromise = owner.page.waitForEvent("download");
    await owner.page.getByRole("menuitem", { name: "Download all (.zip)" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    const path = await download.path();
    const entries = unzipSync(new Uint8Array(await readFile(path)));
    const names = Object.keys(entries).sort();
    expect(names).toEqual(expect.arrayContaining(["notes.md", "util.py"]));
    expect(names.length).toBe(3);
    const text = (name: string) => new TextDecoder().decode(entries[name]);
    expect(text("util.py")).toBe("def helper(): pass");
    expect(text("notes.md")).toBe("# Notes");
  } finally {
    await closeAll(owner);
  }
});
