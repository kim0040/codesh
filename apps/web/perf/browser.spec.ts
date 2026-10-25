import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import {
  FIXTURE,
  FIXTURE_LINES,
  type Member,
  newSession,
  PERF_URL,
  SimClients,
} from "./sim-clients";

/**
 * docs/OPERATIONS.md §11.3: one real browser in a class of 50 (9 simulated writers at 5 keys/s,
 * 40 viewers moving their cursor 5 times a second), the same class inside the browser's view (a
 * bounded text where all 49 remote cursors and some selections are on screen), and a teacher's grid
 * of 50 typing students. Each phase records long tasks, long animation frames, the keydown-to-next-
 * frame proxy, frame times and Chromium's own script/layout/style totals, and writes them to
 * .box-out/perf/browser-*.json.
 */

const LABEL = process.env.E2E_PERF_LABEL ?? "run";
/** `off` measures with the smooth typing setting switched off. */
const SMOOTH = process.env.E2E_PERF_SMOOTH ?? "on";
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.box-out/perf");
const PHASE_MS = 12_000;
/** What one person types in the browser, at about 8 keys a second. */
const CODE = "function add(a, b) {\nreturn a + b;\n}\n";
const KEY_DELAY_MS = 120;
/** One short line, typed on the in-view text's last line. */
const IN_VIEW_CODE = "let n = a + b;";
/** Sustained frame rate every phase must keep: 60 fps with 5 fps (about 8%) of measurement slack. */
const MIN_FPS = 55;
/** Every `SELECTING`th simulated viewer holds a selection in the in-view class. */
const SELECTING = 4;

interface PhaseResult {
  phase: string;
  seconds: number;
  keys: number;
  longTasks: { count: number; maxMs: number; totalMs: number };
  longFrames: { count: number; maxMs: number; blockingMs: number; top: [string, number][] };
  /**
   * From a keydown to a task queued in the next animation frame. A scheduling proxy: it is not tied
   * to the editor update of that key, so it says nothing about when the typed text is visible.
   */
  keydownToFrameMs: Stats;
  /** Remote carets and selections that intersect the editor's scroller, sampled during the phase. */
  visible?: { samples: number; carets: Range; selections: Range };
  frameMs: Stats & { over33: number; over50: number; fps: number };
  /**
   * Chromium's totals over the phase, per second: ms in script, layout, style and tasks, the main
   * thread's CPU ms (`cpu`, which a busy machine does not inflate) and style/layout passes.
   */
  perSecond: {
    script: number;
    layout: number;
    style: number;
    task: number;
    cpu: number;
    styleCount: number;
    layoutCount: number;
  };
}

interface Range {
  min: number;
  max: number;
}

interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function rangeOf(values: number[]): Range {
  return { min: Math.min(...values), max: Math.max(...values) };
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Starts the in-page recorders; `window.__perf` resets and reads them. */
async function installRecorder(page: Page) {
  await page.evaluate(() => {
    const data = {
      longTasks: [] as number[],
      frames: [] as { duration: number; blocking: number; scripts: string[] }[],
      input: [] as number[],
      visible: [] as { carets: number; selections: number }[],
      frameGaps: [] as number[],
      keys: 0,
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) data.longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          blockingDuration: number;
          scripts: { invoker: string; sourceFunctionName: string; duration: number }[];
        })[]) {
          data.frames.push({
            duration: entry.duration,
            blocking: entry.blockingDuration,
            scripts: entry.scripts
              .filter((s) => s.duration >= 5)
              .map((s) => `${s.invoker}|${s.sourceFunctionName}`),
          });
        }
      }).observe({ type: "long-animation-frame" });
    } catch {
      // Older engines have no long-animation-frame entries; long tasks still count.
    }
    document.addEventListener(
      "keydown",
      (event) => {
        data.keys++;
        const start = event.timeStamp;
        // A task queued from the next frame callback: a proxy for "the frame after the key", not a
        // measure of when the editor shows the typed text.
        requestAnimationFrame(() => setTimeout(() => data.input.push(performance.now() - start)));
      },
      { capture: true },
    );
    let last = performance.now();
    const frame = (time: number) => {
      data.frameGaps.push(time - last);
      last = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const countInView = (selector: string, box: DOMRect) =>
      [...document.querySelectorAll(selector)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
      }).length;
    const sampleVisible = () => {
      const scroller = document.querySelector(".cm-scroller");
      if (!scroller) return;
      const box = scroller.getBoundingClientRect();
      data.visible.push({
        carets: countInView(".cm-remote-caret-bar", box),
        selections: countInView(".cm-remote-selection", box),
      });
    };
    let visibleTimer: ReturnType<typeof setInterval> | undefined;
    (window as unknown as { __perf: unknown }).__perf = {
      watchVisible() {
        sampleVisible();
        visibleTimer = setInterval(sampleVisible, 2000);
      },
      unwatchVisible() {
        clearInterval(visibleTimer);
        sampleVisible();
      },
      reset() {
        data.longTasks.length = 0;
        data.frames.length = 0;
        data.input.length = 0;
        data.visible.length = 0;
        data.frameGaps.length = 0;
        data.keys = 0;
      },
      read: () => JSON.parse(JSON.stringify(data)),
    };
  });
}

type Recorded = {
  longTasks: number[];
  frames: { duration: number; blocking: number; scripts: string[] }[];
  input: number[];
  visible: { carets: number; selections: number }[];
  frameGaps: number[];
  keys: number;
};

async function cdpTotals(cdp: CDPSession) {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    script: get("ScriptDuration"),
    layout: get("LayoutDuration"),
    style: get("RecalcStyleDuration"),
    task: get("TaskDuration"),
    cpu: get("ThreadTime"),
    styleCount: get("RecalcStyleCount") / 1000,
    layoutCount: get("LayoutCount") / 1000,
  };
}

/** Measures one phase while the page types (or only watches). */
async function measure(
  page: Page,
  cdp: CDPSession,
  phase: string,
  options: { typing: boolean; inView?: boolean },
): Promise<PhaseResult> {
  const perf = (call: "reset" | "watchVisible" | "unwatchVisible") =>
    page.evaluate(
      (name) => (window as unknown as { __perf: Record<string, () => void> }).__perf[name]?.(),
      call,
    );
  await perf("reset");
  if (options.inView) await perf("watchVisible");
  const before = await cdpTotals(cdp);
  const started = Date.now();
  if (options.typing) {
    while (Date.now() - started < PHASE_MS) {
      if (options.inView) {
        // Types on the last line and wipes it, so the text stays on one screen.
        await page.keyboard.type(IN_VIEW_CODE, { delay: KEY_DELAY_MS });
        await page.keyboard.press("Shift+Home");
        await page.keyboard.press("Backspace");
      } else {
        await page.keyboard.type(CODE, { delay: KEY_DELAY_MS });
      }
    }
  } else {
    await page.waitForTimeout(PHASE_MS);
  }
  const seconds = (Date.now() - started) / 1000;
  const after = await cdpTotals(cdp);
  if (options.inView) await perf("unwatchVisible");
  const data = (await page.evaluate(() =>
    (window as unknown as { __perf: { read(): unknown } }).__perf.read(),
  )) as Recorded;
  const scripts = new Map<string, number>();
  for (const frame of data.frames) {
    for (const script of frame.scripts) scripts.set(script, (scripts.get(script) ?? 0) + 1);
  }
  const frameStats = stats(data.frameGaps);
  const perSecond = (key: keyof typeof before) =>
    Math.round(((after[key] - before[key]) * 1000 * 10) / seconds) / 10;
  return {
    phase,
    seconds,
    keys: data.keys,
    longTasks: {
      count: data.longTasks.length,
      maxMs: Math.max(0, ...data.longTasks),
      totalMs: data.longTasks.reduce((a, b) => a + b, 0),
    },
    longFrames: {
      count: data.frames.length,
      maxMs: Math.max(0, ...data.frames.map((f) => f.duration)),
      blockingMs: data.frames.reduce((a, f) => a + f.blocking, 0),
      top: [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 8),
    },
    keydownToFrameMs: stats(data.input),
    visible: options.inView
      ? {
          samples: data.visible.length,
          carets: rangeOf(data.visible.map((v) => v.carets)),
          selections: rangeOf(data.visible.map((v) => v.selections)),
        }
      : undefined,
    frameMs: {
      ...frameStats,
      over33: data.frameGaps.filter((g) => g > 33.4).length,
      over50: data.frameGaps.filter((g) => g > 50).length,
      fps: Math.round((data.frameGaps.length / seconds) * 10) / 10,
    },
    perSecond: {
      script: perSecond("script"),
      layout: perSecond("layout"),
      style: perSecond("style"),
      task: perSecond("task"),
      cpu: perSecond("cpu"),
      styleCount: perSecond("styleCount"),
      layoutCount: perSecond("layoutCount"),
    },
  };
}

function save(name: string, phases: PhaseResult[]) {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = resolve(OUT_DIR, `browser-${name}-${LABEL}-${stamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ name, label: LABEL, url: PERF_URL, phases }, null, 2)}\n`,
  );
  for (const p of phases) {
    console.log(
      `${name}/${p.phase}: long tasks ${p.longTasks.count} (max ${p.longTasks.maxMs.toFixed(0)} ms), ` +
        `long frames ${p.longFrames.count} (max ${p.longFrames.maxMs.toFixed(0)} ms), ` +
        `keydown→frame (proxy) p50/p95/max ${p.keydownToFrameMs.p50.toFixed(1)}/${p.keydownToFrameMs.p95.toFixed(1)}/${p.keydownToFrameMs.max.toFixed(1)} ms, ` +
        `fps ${p.frameMs.fps}, frames >50 ms ${p.frameMs.over50}, ` +
        (p.visible
          ? `visible carets ${p.visible.carets.min}–${p.visible.carets.max}, selections ${p.visible.selections.min}–${p.visible.selections.max} (${p.visible.samples} samples), `
          : "") +
        `script/layout/style ${p.perSecond.script}/${p.perSecond.layout}/${p.perSecond.style} ms/s, ` +
        `main-thread cpu ${p.perSecond.cpu} ms/s, style/layout passes ${p.perSecond.styleCount}/${p.perSecond.layoutCount} per s`,
    );
  }
  console.log(`saved ${file}`);
}

async function openPage(browser: import("@playwright/test").Browser, name: string) {
  const context = await browser.newContext({
    baseURL: PERF_URL,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "X-Gachipad": "1" },
  });
  const response = await context.request.patch("/api/session", { data: { name } });
  expect(response.ok()).toBe(true);
  if (SMOOTH === "off") {
    await context.addInitScript(() =>
      localStorage.setItem("gachipad.prefs", JSON.stringify({ smoothTyping: false })),
    );
  }
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  return { context, page, cdp };
}

test.setTimeout(240_000);

/** The owner's browser in a new share that others may view, plus the 49 members to join it. */
async function openClassShare(browser: import("@playwright/test").Browser) {
  const { context, page, cdp } = await openPage(browser, "perf-owner");
  await page.goto("/");
  await page.getByTestId("new-share").click();
  await page.waitForURL((url) => url.pathname !== "/");
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  const shareId = new URL(page.url()).pathname.split("/").filter(Boolean).pop() as string;
  const patched = await context.request.patch(`/api/shares/${shareId}`, {
    data: { access: { default: "view" } },
  });
  expect(patched.ok()).toBe(true);
  const share = (await (await context.request.get(`/api/shares/${shareId}`)).json()) as {
    access: { editKey: string };
  };
  await installRecorder(page);
  await page.locator(".cm-content").click();
  const members: Member[] = [
    ...Array.from({ length: 9 }, () => ({
      shareId,
      body: { editKey: share.access.editKey },
      writer: true,
    })),
    ...Array.from({ length: 40 }, () => ({ shareId, body: {}, writer: false })),
  ];
  return { context, page, cdp, shareId, members };
}

test("class of 50: typing stays smooth with 49 others", async ({ browser }) => {
  const { context, page, cdp, shareId, members } = await openClassShare(browser);

  const phases: PhaseResult[] = [];
  phases.push(await measure(page, cdp, "alone", { typing: true }));

  const sims = await SimClients.join(members);
  try {
    sims.placeCursors();
    // Four avatars and "+46": everyone is in.
    await expect(page.getByTestId("people")).toContainText("+46", { timeout: 15_000 });
    phases.push(await measure(page, cdp, "49 present, still", { typing: true }));
    sims.start({ typeRate: 0, cursorRate: 5 });
    phases.push(await measure(page, cdp, "40 cursors moving", { typing: true }));
    sims.stop();
    sims.start({ typeRate: 5, cursorRate: 5 });
    phases.push(await measure(page, cdp, "class: 9 typing + 40 moving", { typing: true }));
    phases.push(await measure(page, cdp, "class, watching only", { typing: false }));
  } finally {
    await sims.close();
  }
  save("class-50", phases);
  await context.request.delete(`/api/shares/${shareId}`);
  await context.close();

  for (const p of phases) {
    expect.soft(p.longTasks.maxMs, `${p.phase}: longest task`).toBeLessThanOrEqual(50);
    expect.soft(p.keydownToFrameMs.p95, `${p.phase}: keydown to frame p95`).toBeLessThan(50);
    expect.soft(p.frameMs.fps, `${p.phase}: fps`).toBeGreaterThanOrEqual(MIN_FPS);
  }
});

test("class of 50 in view: 49 carets and selections on screen", async ({ browser }) => {
  const { context, page, cdp, shareId, members } = await openClassShare(browser);
  const sims = await SimClients.join(members);
  const phases: PhaseResult[] = [];
  try {
    // The text is short enough for one screen; writers rewrite lines of their own inside it and
    // the viewers move and select inside it too, so every remote cursor is drawn.
    sims.seed(FIXTURE);
    await expect(page.locator(".cm-content")).toContainText(`value${FIXTURE_LINES}`);
    sims.startInView({ typeRate: 5, cursorRate: 5 }, FIXTURE_LINES, SELECTING);
    await expect(page.getByTestId("people")).toContainText("+46", { timeout: 15_000 });
    // The owner types on the empty last line.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    phases.push(
      await measure(page, cdp, "49 in view: 9 typing + 40 moving", { typing: true, inView: true }),
    );
    phases.push(
      await measure(page, cdp, "49 in view, watching only", { typing: false, inView: true }),
    );
  } finally {
    await sims.close();
  }
  save("class-50-visible", phases);
  await context.request.delete(`/api/shares/${shareId}`);
  await context.close();

  for (const p of phases) {
    // All 49 others are on screen throughout; a quarter of the viewers hold a selection, which
    // collapses for a moment when a writer clears the line it sits on, so only half are required.
    expect(p.visible?.carets.min, `${p.phase}: carets in view`).toBe(49);
    expect(p.visible?.selections.min, `${p.phase}: selections in view`).toBeGreaterThanOrEqual(
      Math.floor(40 / SELECTING / 2),
    );
    expect.soft(p.longTasks.maxMs, `${p.phase}: longest task`).toBeLessThanOrEqual(50);
    expect.soft(p.keydownToFrameMs.p95, `${p.phase}: keydown to frame p95`).toBeLessThan(50);
    expect.soft(p.frameMs.fps, `${p.phase}: fps`).toBeGreaterThanOrEqual(MIN_FPS);
  }
});

test("lab of 50: the teacher's grid stays responsive", async ({ browser }) => {
  const { context, page, cdp } = await openPage(browser, "perf-teacher");
  const created = await context.request.post("/api/labs", { data: { title: "perf lab" } });
  expect(created.ok()).toBe(true);
  const labId = ((await created.json()) as { id: string }).id;
  const students = await Promise.all(
    Array.from({ length: 50 }, async (_, i) => {
      const api = await newSession(`student${i + 1}`);
      const joined = await api.post(`/api/labs/${labId}/join`, {
        data: { name: `student${i + 1}` },
      });
      if (!joined.ok()) throw new Error(`join lab ${joined.status()}`);
      const { shareId } = (await joined.json()) as { shareId: string };
      return { shareId, body: {}, writer: true, api } satisfies Member;
    }),
  );
  const sims = await SimClients.join(students);
  const phases: PhaseResult[] = [];
  try {
    await page.goto(`/lab/${labId}`);
    await expect(page.getByTestId("lab-grid")).toBeVisible();
    await installRecorder(page);
    phases.push(await measure(page, cdp, "50 students idle", { typing: false }));
    sims.start({ typeRate: 3, cursorRate: 0 });
    phases.push(await measure(page, cdp, "50 students typing", { typing: false }));
  } finally {
    await sims.close();
  }
  save("lab-50", phases);
  await context.close();

  for (const p of phases) {
    expect.soft(p.longTasks.maxMs, `${p.phase}: longest task`).toBeLessThanOrEqual(50);
    expect.soft(p.frameMs.over50, `${p.phase}: frames over 50 ms`).toBeLessThanOrEqual(p.seconds);
    expect.soft(p.frameMs.fps, `${p.phase}: fps`).toBeGreaterThanOrEqual(MIN_FPS);
  }
});
