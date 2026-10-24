import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import { closeAll, newUser, waitForEditor } from "./helpers";

// Real snapshots are written at most every 30 s, so the history list and its states are served from
// the test with a fixed delay per state: playback has to stay smooth on a slow network too.
const VERSIONS = 30;
const LATENCY_MS = 150;
// HistoryView: 900 ms per version at 1×, the fastest speed is 4×.
const STEP_MS = 900 / 4;

function stateOf(version: number): Buffer {
  const doc = new Y.Doc();
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    doc.getMap<Y.Map<unknown>>("files").set("main", entry);
    entry.set("path", "main.ts");
    entry.set("language", "typescript");
    entry.set("order", 0);
    const lines = Array.from({ length: version }, (_, i) => `const v${i + 1} = ${i + 1};`);
    doc.getText("file:main").insert(0, `${lines.join("\n")}\n`);
  });
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
}

async function serveHistory(page: Page, id: string): Promise<{ requests: () => number }> {
  let requests = 0;
  const start = Date.now() - VERSIONS * 60_000;
  await page.route(`**/api/shares/${id}/history`, (route) =>
    route.fulfill({
      json: Array.from({ length: VERSIONS }, (_, i) => ({
        seq: i + 1,
        at: new Date(start + i * 60_000).toISOString(),
      })),
    }),
  );
  await page.route(`**/api/shares/${id}/history/*`, async (route) => {
    requests++;
    const seq = Number(new URL(route.request().url()).pathname.split("/").pop());
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    await route.fulfill({ contentType: "application/octet-stream", body: stateOf(seq) });
  });
  return { requests: () => requests };
}

test("history playback at the fastest speed never falls back to the loading state", async ({
  browser,
}) => {
  const owner = await newUser(browser, "Owner");
  try {
    const created = await owner.context.request.post("/api/shares", {
      data: { title: "playback", files: [{ path: "main.ts", content: "const now = 0;\n" }] },
    });
    const { id } = (await created.json()) as { id: string };
    const served = await serveHistory(owner.page, id);
    await owner.page.goto(`/${id}`);
    await waitForEditor(owner.page);

    await owner.page.getByTestId("history-button").click();
    const view = owner.page.getByTestId("history-view");
    await expect(view.getByTestId("diff")).toContainText(`const v${VERSIONS} = ${VERSIONS};`);

    await view.getByRole("button", { name: "4×" }).click();
    // Records, inside the page, every step of the timeline, how long the matching version took to
    // show, and every loading state or editor mount from here on.
    await owner.page.evaluate(() => {
      const root = document.querySelector('[data-testid="history-view"]') as HTMLElement;
      const log = { steps: [] as number[], lags: [] as number[], busy: 0, mounts: 0 };
      (window as unknown as { __playback: typeof log }).__playback = log;
      const indexOf = () =>
        Number(
          root.querySelector<HTMLElement>('[data-testid="history-label"]')?.dataset.index ?? -1,
        );
      let current = indexOf();
      let stepAt = 0;
      let waiting = false;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.matches(".cm-mergeView, .cm-editor")) log.mounts++;
            if (node.matches('[aria-busy="true"]') || node.querySelector('[aria-busy="true"]')) {
              log.busy++;
            }
          }
        }
        const index = indexOf();
        if (index !== current) {
          current = index;
          log.steps.push(index);
          stepAt = performance.now();
          waiting = true;
        }
        // The newer side of the diff holds one `const vN` line per version.
        const editors = root.querySelectorAll(".cm-mergeViewEditor");
        const lines = editors[editors.length - 1]?.querySelectorAll(".cm-line") ?? [];
        const shown = [...lines].filter((line) => /const v\d+ =/.test(line.textContent ?? ""));
        if (waiting && shown.length === index + 1) {
          log.lags.push(performance.now() - stepAt);
          waiting = false;
        }
      }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    });

    const before = served.requests();
    const started = Date.now();
    await view.getByTestId("history-play").click();
    await expect(view.getByTestId("history-label")).toHaveAttribute(
      "data-index",
      String(VERSIONS - 1),
      { timeout: VERSIONS * STEP_MS + 5_000 },
    );
    const elapsed = Date.now() - started;
    await expect(view.getByTestId("diff")).toContainText(`const v${VERSIONS} = ${VERSIONS};`);

    const log = await owner.page.evaluate(
      () =>
        (
          window as unknown as {
            __playback: { steps: number[]; lags: number[]; busy: number; mounts: number };
          }
        ).__playback,
    );
    console.log(
      JSON.stringify({
        elapsed,
        steps: log.steps.length,
        meanLagMs: Math.round(log.lags.reduce((sum, lag) => sum + lag, 0) / log.lags.length),
        maxLagMs: Math.round(Math.max(...log.lags.slice(1))),
        requests: served.requests() - before,
        loadingStates: log.busy,
        editorMounts: log.mounts,
      }),
    );

    expect(log.steps, "every version is played in order").toEqual(
      Array.from({ length: VERSIONS }, (_, i) => i),
    );
    expect(log.busy, "a loading state appeared during playback").toBe(0);
    expect(log.mounts, "the diff view was rebuilt during playback").toBe(0);
    expect(Math.max(...log.lags.slice(1)), "a version lagged behind the timeline").toBeLessThan(
      STEP_MS,
    );
    expect(elapsed).toBeLessThanOrEqual(VERSIONS * STEP_MS + 1_000);
  } finally {
    await closeAll(owner);
  }
});
