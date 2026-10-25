/**
 * Summarises the result files of `pnpm load` and the browser perf specs in one Markdown report:
 *
 *   pnpm load:report [dir]     # default <repo>/.box-out/perf, writes <dir>/report.md
 *
 * Every file is one row, oldest first, so a before/after pair reads top to bottom.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Latency {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface LoadResult {
  scenario: string;
  label: string;
  startedAt: string;
  clients: { attempted: number; synced: number };
  deliveries: { expected: number; received: number };
  latencyMs: Latency;
  stormEditLatencyMs: Latency | null;
  awarenessLatencyMs: Latency;
  convergence: {
    shares: number;
    converged: number;
    missingMarkers: number;
    duplicatedMarkers: number;
  };
  storm: {
    kind: string;
    command: string | null;
    clients: number;
    lost: number;
    within5s: number;
    reconnectMs: Latency;
  } | null;
  errors: { total: number };
  generator: { cpuCores: number };
  server: {
    collabCpuCores: number | null;
    wsMessagesPerS: number | null;
    wsBytesPerS: number | null;
    flushesPerS: number | null;
    collabLagP99Ms: number | null;
    collabRssPeakMiB: number | null;
  };
  resources: {
    services: Record<string, { cpuAvg: number; cpuPeak: number; memPeakMiB: number }>;
    host: { cores: number; cpuAvg: number; cpuPeak: number } | null;
  } | null;
  ok: boolean;
}

interface BrowserPhase {
  phase: string;
  longTasks: { count: number; maxMs: number };
  longFrames: { count: number; maxMs: number };
  /** Called `inputToPaintMs` in files from before the metric was renamed. */
  keydownToFrameMs?: Latency;
  inputToPaintMs?: Latency;
  visible?: { carets: { min: number; max: number }; selections: { min: number; max: number } };
  frameMs: { fps: number; over50: number };
  perSecond: {
    script: number;
    layout: number;
    style: number;
    cpu?: number;
    styleCount?: number;
    layoutCount?: number;
  };
}

interface BrowserResult {
  name: string;
  label: string;
  phases: BrowserPhase[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = resolve(process.argv[2] ?? join(root, ".box-out/perf"));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort((a, b) => stampOf(a).localeCompare(stampOf(b)));

/** Files end in an ISO time; sorting by it keeps runs in the order they happened. */
function stampOf(name: string): string {
  return /(\d{4}-\d\d-\d\dT[\d-]+Z)\.json$/.exec(name)?.[1] ?? name;
}

// A negative rate is a counter reset that runs older than the reset-aware `increase` missed.
const n = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || value < 0 ? "-" : value.toFixed(digits);
/** `-` for an empty sample (a phase with no typing, a storm nobody noticed). */
const ms = (l: Latency | null, keys: (keyof Latency)[]) =>
  l && l.count > 0 ? keys.map((k) => n(l[k])).join(" / ") : "-";

/** `PERF_DIR=/x /repo/scripts/load/perf-stack.sh restart-collab` -> `perf-stack.sh restart-collab`. */
const shortCommand = (command: string | null) =>
  command?.replace(/\b[A-Z_]+=\S+\s*/g, "").replace(/\S*\//g, "") ?? null;

const load: string[] = [];
const storms: string[] = [];
const resources: string[] = [];
const browser: string[] = [];
for (const file of files) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as LoadResult | BrowserResult;
  if ("phases" in data) {
    for (const p of data.phases) {
      browser.push(
        `| ${data.name} | ${data.label} | ${p.phase} | ${p.longTasks.count} (${n(p.longTasks.maxMs, 0)}) | ` +
          `${p.longFrames.count} (${n(p.longFrames.maxMs, 0)}) | ${ms(p.keydownToFrameMs ?? p.inputToPaintMs ?? null, ["p50", "p95", "max"])} | ` +
          `${n(p.frameMs.fps)} / ${p.frameMs.over50} | ${n(p.perSecond.script)} / ${n(p.perSecond.layout)} / ${n(p.perSecond.style)} | ` +
          `${n(p.perSecond.cpu)} | ${n(p.perSecond.styleCount, 0)} / ${n(p.perSecond.layoutCount, 0)} | ` +
          `${p.visible ? `${p.visible.carets.min}–${p.visible.carets.max} / ${p.visible.selections.min}–${p.visible.selections.max}` : "-"} |`,
      );
    }
    continue;
  }
  const r = data;
  const lostOrDup = r.convergence.missingMarkers + r.convergence.duplicatedMarkers;
  load.push(
    `| ${r.scenario} | ${r.label} | ${r.clients.synced}/${r.clients.attempted} | ` +
      `${ms(r.latencyMs, ["p50", "p95", "p99", "max"])} | ${ms(r.awarenessLatencyMs, ["p50", "p95", "p99"])} | ` +
      `${r.deliveries.received}/${r.deliveries.expected} | ${lostOrDup} | ` +
      `${r.convergence.converged}/${r.convergence.shares} | ${r.errors.total} | ` +
      `${n(r.server.wsMessagesPerS, 0)} | ${n(r.server.collabCpuCores, 2)} | ${n(r.server.collabLagP99Ms)} | ` +
      `${r.ok ? "OK" : "FAILED"} |`,
  );
  if (r.storm) {
    const storm = r.stormEditLatencyMs;
    storms.push(
      `| ${r.scenario} | ${r.label} | ${shortCommand(r.storm.command) ?? r.storm.kind} | ${r.storm.lost}/${r.storm.clients} | ` +
        `${r.storm.within5s}/${r.storm.clients} | ${ms(r.storm.reconnectMs, ["p50", "p95", "max"])} | ` +
        `${ms(storm, ["p50", "p95", "max"])} | ${lostOrDup} |`,
    );
  }
  const services = r.resources?.services ?? {};
  const svc = (name: string) => {
    const s = services[name];
    return s ? `${n(s.cpuAvg, 0)} / ${n(s.cpuPeak, 0)} / ${n(s.memPeakMiB, 0)}` : "-";
  };
  const host = r.resources?.host;
  resources.push(
    `| ${r.scenario} | ${r.label} | ${svc("collab")} | ${svc("api")} | ${svc("mongo")} | ${svc("valkey")} | ` +
      `${svc("caddy")} | ${host ? `${n(host.cpuAvg, 0)} / ${n(host.cpuPeak, 0)}` : "-"} | ${n(r.generator.cpuCores, 2)} |`,
  );
}

const lines = [
  "# gachipad load results",
  "",
  `Generated by \`pnpm load:report\` from ${files.length} files in \`${dir.replace(root, "<repo>")}\`, oldest first.`,
  "Targets and the test setup: docs/OPERATIONS.md §11. Every number comes from one shared VM that",
  "also runs the load generator and the browser, so absolute values are pessimistic and noisy;",
  "compare rows measured close together.",
  "",
  "## Server scenarios",
  "",
  "Latency in ms (edit: typed in one client → seen in another; cursor: published → seen).",
  "",
  "| Scenario | Label | Synced | Edit p50 / p95 / p99 / max | Cursor p50 / p95 / p99 | Delivered | Lost + dup | Converged | Errors | WS msgs/s | Collab cores | Collab lag p99 | Result |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...load,
  "",
  "## Reconnect storms",
  "",
  "Kind `drop` cuts every socket at once; otherwise the command that ran. Clients that kept their",
  "connection (a Valkey or MongoDB blip) count as resynced at once.",
  "",
  "| Scenario | Label | Kind | Disconnected | Resynced ≤ 5 s | Resync p50 / p95 / max ms | Edits typed during it p50 / p95 / max ms | Lost + dup |",
  "|---|---|---|---|---|---|---|---|",
  ...storms,
  "",
  "## Resources (docker stats: CPU % of one core avg / peak, memory peak MiB)",
  "",
  "| Scenario | Label | collab | api | mongo | valkey | caddy | Host CPU % avg / peak | Generator cores |",
  "|---|---|---|---|---|---|---|---|---|",
  ...resources,
  "",
  "## Browser (one real Chromium, headless, software rendering)",
  "",
  "Keydown → next frame is a scheduling proxy (a task queued from the frame after the key); it does not",
  "show when the editor displays the typed text. Files from before the rename call it input → paint.",
  "",
  "| Test | Label | Phase | Long tasks (max ms) | Long frames (max ms) | Keydown → next frame (proxy) p50 / p95 / max ms | fps / frames > 50 ms | Script / layout / style ms per s | Main-thread CPU ms per s | Style / layout passes per s | Carets / selections in view min–max |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...browser,
  "",
];
writeFileSync(join(dir, "report.md"), lines.join("\n"));
console.log(`wrote ${join(dir, "report.md")}`);
