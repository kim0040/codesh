// Load test for the collab path (docs/OPERATIONS.md §11). No k6 (AGPL): plain
// Node clients.
//
//   pnpm load -- --scenario single-share-50 --url http://host --docker-project gachipad
//   pnpm load -- --shares 100 --writers 5 --viewers 20 --duration 60 --url http://host
//
// Writers type markers at a fixed rate and move their cursor with every keystroke, like the editor;
// viewers move their cursor. Edit latency is measured per delivery, from the moment a writer
// inserts a marker to the moment another client's Y.Text observes it; awareness latency from the
// moment a client publishes a cursor to the moment another client sees it. The clients run in
// worker threads (worker.ts) that share one clock. At the end every client of a share must hold the
// same text with every typed marker exactly once, and the latest cursor of everyone else.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ApiClient, createAgent } from "./api.js";
import { type Options, parseOptions, planOf, USAGE } from "./args.js";
import {
  type ClientJob,
  type FromWorker,
  now,
  type Replica,
  type ToWorker,
  type WorkerConfig,
  type WorkerResults,
} from "./protocol.js";
import { checkBudgets, startResourceSampler } from "./resources.js";
import { clientCount, type LabGroup, type ShareGroup } from "./scenarios.js";
import { increase, metricValue, summarize } from "./stats.js";

interface Share {
  group: string;
  id: string;
  /** Deletes the share afterwards. */
  owner: ApiClient;
}

const options = parseOptions(process.argv.slice(2));
if (!options) {
  console.log(USAGE);
  process.exit(0);
}
const opts: Options = options;
const plan = planOf(opts);

const totalClients = plan.groups.reduce((n, g) => n + clientCount(g), 0);
const agent = createAgent(Math.min(256, opts.concurrency * 2));
const counters = { rateLimited: 0, clients: 0 };
const failures = new Map<string, number>();
const shares: Share[] = [];
const jobs: ClientJob[] = [];
const nullIfNaN = (value: number) => (Number.isNaN(value) ? null : value);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason: string, count = 1) =>
  failures.set(reason, (failures.get(reason) ?? 0) + count);
const newApi = () =>
  new ApiClient(opts.url, agent, () => {
    counters.rateLimited++;
  });

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  await Promise.all(workers);
}

// --- metrics ---------------------------------------------------------------------------------

const METRICS = {
  api: [
    "gachipad_http_request_duration_seconds_count",
    "gachipad_shares_created_total",
    "gachipad_rate_limited_total",
    "gachipad_sse_connections",
    "gachipad_api_process_cpu_seconds_total",
    "gachipad_api_process_resident_memory_bytes",
    "gachipad_api_nodejs_eventloop_lag_p99_seconds",
  ],
  collab: [
    "gachipad_collab_connections",
    "gachipad_collab_documents_loaded",
    "gachipad_collab_updates_total",
    "gachipad_collab_flush_seconds_count",
    "gachipad_collab_flush_seconds_sum",
    "gachipad_collab_flush_errors_total",
    "gachipad_collab_slow_client_closes_total",
    "gachipad_collab_refused_too_large_total",
    "gachipad_collab_ws_messages_sent_total",
    "gachipad_collab_ws_bytes_sent_total",
    "gachipad_collab_awareness_dropped_total",
    "gachipad_collab_process_cpu_seconds_total",
    "gachipad_collab_process_resident_memory_bytes",
    "gachipad_collab_nodejs_heap_size_used_bytes",
    "gachipad_collab_nodejs_eventloop_lag_p99_seconds",
    "gachipad_collab_nodejs_eventloop_lag_max_seconds",
  ],
} as const;

type Snapshot = {
  at: string;
  api: Record<string, number> | null;
  collab: Record<string, number> | null;
};

async function scrape(
  url: string,
  names: readonly string[],
): Promise<Record<string, number> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const text = await response.text();
    if (!response.ok || !text.includes("# TYPE")) return null;
    const out: Record<string, number> = {};
    for (const name of names) {
      const value = metricValue(text, name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  } catch {
    return null;
  }
}

const snapshot = async (): Promise<Snapshot> => ({
  at: new Date().toISOString(),
  api: await scrape(opts.metricsApi, METRICS.api),
  collab: await scrape(opts.metricsCollab, METRICS.collab),
});

// --- setup -----------------------------------------------------------------------------------

async function startSession(api: ApiClient): Promise<void> {
  const session = await api.call("GET", "/api/session");
  if (session.status !== 200) throw new Error(`session ${session.status}`);
}

function addJob(job: Omit<ClientJob, "key">) {
  jobs.push({ key: `c${counters.clients++}`, ...job });
}

async function createShare(group: ShareGroup, index: number, stamp: string): Promise<void> {
  const owner = newApi();
  try {
    await startSession(owner);
    const created = await owner.call<{ id: string }>("POST", "/api/shares", {
      title: `load-${stamp}-${group.name}-${index}`,
      files: [{ path: "main.txt", content: "// gachipad load test\n" }],
    });
    if (created.status !== 200) throw new Error(`create ${created.status}`);
    const { id } = created.json;
    // Viewers join with the default access, editors with the edit key.
    const patched = await owner.call("PATCH", `/api/shares/${id}`, { access: { default: "view" } });
    if (patched.status !== 200) throw new Error(`patch ${patched.status}`);
    const view = await owner.call<{ access?: { editKey: string } }>("GET", `/api/shares/${id}`);
    const editKey = view.json.access?.editKey;
    if (!editKey) throw new Error("no edit key");
    const shareIndex = shares.length;
    shares.push({ group: group.name, id, owner });
    const base = { group: group.name, shareId: id, shareIndex, socketKey: null };
    for (let k = 0; k < group.writers; k++) {
      addJob({
        ...base,
        writer: k,
        cookie: k === 0 ? owner.cookie : null,
        body: k === 0 ? {} : { editKey },
        roles: [k === 0 ? "owner" : "edit"],
        perSecond: group.typeRate,
      });
    }
    for (let k = 0; k < group.viewers; k++) {
      addJob({
        ...base,
        writer: null,
        cookie: null,
        body: {},
        roles: ["view"],
        perSecond: group.cursorRate,
      });
    }
  } catch (error) {
    fail(`create share: ${(error as Error).message}`);
  }
}

/** A lab: the teacher creates it, every student joins and gets a copy the teacher watches. */
async function createLab(group: LabGroup, stamp: string): Promise<void> {
  const teacher = newApi();
  try {
    await startSession(teacher);
    const created = await teacher.call<{ id: string }>("POST", "/api/labs", {
      title: `load-${stamp}-${group.name}`,
    });
    if (created.status !== 200) throw new Error(`create lab ${created.status}`);
    const labId = created.json.id;
    const students = Array.from({ length: group.students }, (_, i) => i);
    await pool(students, opts.concurrency, async (i) => {
      const student = newApi();
      try {
        await startSession(student);
        const joined = await student.call<{ shareId: string }>("POST", `/api/labs/${labId}/join`, {
          name: `student ${i + 1}`,
        });
        if (joined.status !== 200) throw new Error(`join lab ${joined.status}`);
        const id = joined.json.shareId;
        const shareIndex = shares.length;
        shares.push({ group: group.name, id, owner: student });
        const base = { group: group.name, shareId: id, shareIndex, body: {} };
        addJob({
          ...base,
          writer: 0,
          cookie: student.cookie,
          roles: ["owner", "edit"],
          socketKey: null,
          perSecond: group.typeRate,
        });
        // The teacher's grid: one tab, one socket, every copy multiplexed over it.
        addJob({
          ...base,
          writer: null,
          cookie: teacher.cookie,
          roles: [],
          socketKey: `teacher:${labId}`,
          perSecond: 0,
        });
      } catch (error) {
        fail(`lab student: ${(error as Error).message}`);
      }
    });
  } catch (error) {
    fail(`lab: ${(error as Error).message}`);
  }
}

// --- client threads --------------------------------------------------------------------------

class ClientThread {
  readonly worker: Worker;
  private readonly waiting = new Map<string, (message: FromWorker) => void>();

  constructor(config: WorkerConfig) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: config });
    this.worker.on("message", (message: FromWorker) => {
      const resolve = this.waiting.get(message.type);
      this.waiting.delete(message.type);
      resolve?.(message);
    });
    this.worker.on("error", (error) => {
      console.error("load: client thread failed", error);
      process.exit(2);
    });
  }

  /** Sends `message` and resolves with the thread's answer of type `reply`. */
  ask<T extends FromWorker["type"]>(
    message: ToWorker,
    reply: T,
  ): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve) => {
      this.waiting.set(reply, resolve as (message: FromWorker) => void);
      this.worker.postMessage(message);
    });
  }
}

/** Spreads every share over the threads; clients on one shared socket stay in one thread. */
function assign(count: number): ClientJob[][] {
  const out: ClientJob[][] = Array.from({ length: count }, () => []);
  const bySocket = new Map<string, number>();
  let next = 0;
  for (const job of jobs) {
    let index = job.socketKey === null ? undefined : bySocket.get(job.socketKey);
    if (index === undefined) {
      index = next++ % count;
      if (job.socketKey !== null) bySocket.set(job.socketKey, index);
    }
    out[index]?.push(job);
  }
  return out;
}

// --- checks ----------------------------------------------------------------------------------

interface Convergence {
  converged: number;
  complete: number;
  missing: number;
  duplicated: number;
  cursorGaps: number;
  bad: string[];
}

function convergence(replicas: Replica[], list: number[] = shares.map((_, i) => i)): Convergence {
  const byShare = new Map<number, Replica[]>();
  for (const replica of replicas) {
    const entry = byShare.get(replica.shareIndex) ?? [];
    entry.push(replica);
    byShare.set(replica.shareIndex, entry);
  }
  const out: Convergence = {
    converged: 0,
    complete: 0,
    missing: 0,
    duplicated: 0,
    cursorGaps: 0,
    bad: [],
  };
  for (const index of list) {
    const live = (byShare.get(index) ?? []).filter((r) => r.synced);
    const same = live.length > 0 && new Set(live.map((r) => r.hash)).size === 1;
    const first = live[0];
    out.missing += first?.missing ?? 0;
    out.duplicated += first?.duplicated ?? 0;
    if (same) out.converged++;
    if (same && first && first.missing === 0 && first.duplicated === 0) out.complete++;
    else out.bad.push(shares[index]?.id ?? String(index));
    // Every live receiver holds the latest cursor of every live sender.
    for (const receiver of live) {
      const seen = new Map(receiver.seen);
      for (const sender of live) {
        if (sender === receiver || sender.awarenessLast < 0) continue;
        if ((seen.get(sender.key) ?? -1) !== sender.awarenessLast) out.cursorGaps++;
      }
    }
  }
  return out;
}

function runCommand(command: string): Promise<{ exitCode: number; ms: number }> {
  const started = now();
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { timeout: 120_000 }, (error) => {
      if (error) fail(`restart command: ${error.message.split("\n")[0]}`);
      const exitCode = error ? Number((error as { code?: number }).code ?? 1) : 0;
      resolve({ exitCode, ms: now() - started });
    });
  });
}

// --- run -------------------------------------------------------------------------------------

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();
  const groupsText = plan.groups
    .map((g) =>
      g.kind === "lab"
        ? `${g.name}: lab of ${g.students} students at ${g.typeRate}/s`
        : `${g.name}: ${g.shares} x (${g.writers} writers at ${g.typeRate}/s + ${g.viewers} viewers moving ${g.cursorRate}/s)`,
    )
    .join("; ");
  const threadCount = Math.max(1, Math.min(opts.threads ?? availableParallelism(), totalClients));
  console.log(
    `load: ${plan.scenario} [${opts.label}] ${groupsText}; ${plan.durationS}s against ${opts.url}, ${threadCount} client threads`,
  );
  const before = await snapshot();

  for (const group of plan.groups) {
    if (group.kind === "share") {
      const indexes = Array.from({ length: group.shares }, (_, i) => i);
      await pool(indexes, opts.concurrency, (index) => createShare(group, index, stamp));
    } else {
      await createLab(group, stamp);
    }
  }
  console.log(`load: ${shares.length} shares ready`);

  const config: WorkerConfig = {
    url: opts.url,
    connectTimeoutS: opts.connectTimeoutS,
    concurrency: Math.max(1, Math.ceil(opts.concurrency / threadCount)),
  };
  const threads = Array.from({ length: threadCount }, () => new ClientThread(config));
  const parts = assign(threadCount);
  const connected = await Promise.all(
    threads.map((t, i) => t.ask({ type: "connect", jobs: parts[i] ?? [] }, "connected")),
  );
  const attempted = jobs.length;
  const syncedAtStart = connected.reduce((n, c) => n + c.synced, 0);
  const connectLatency = summarize(connected.flatMap((c) => c.connectMs));
  console.log(`load: ${syncedAtStart}/${attempted} clients synced; typing for ${plan.durationS}s`);

  // Typing and cursor moves.
  const samples: Snapshot[] = [];
  const resources = startResourceSampler(opts.dockerProject ?? null, opts.sampleS);
  const atStart = await snapshot();
  const cpuBefore = process.cpuUsage();
  const typingStart = now();
  await Promise.all(threads.map((t) => t.ask({ type: "start" }, "started")));
  const sampler = setInterval(() => {
    void snapshot().then((s) => samples.push(s));
  }, opts.sampleS * 1000);

  let stormAt: number | null = null;
  let command: { exitCode: number; ms: number } | null = null;
  if (plan.storm) {
    const { storm } = plan;
    await sleep(storm.atS * 1000);
    stormAt = now();
    console.log(`load: storm (${storm.kind}) at ${storm.atS}s`);
    const at = stormAt;
    await Promise.all(
      threads.map((t) => t.ask({ type: "storm", kind: storm.kind, at }, "stormed")),
    );
    if (storm.kind === "restart") command = await runCommand(storm.command ?? "true");
    await sleep(Math.max(0, plan.durationS * 1000 - (now() - typingStart)));
  } else {
    await sleep(plan.durationS * 1000);
  }
  const stopped = await Promise.all(threads.map((t) => t.ask({ type: "stop" }, "stopped")));
  clearInterval(sampler);
  const typingMs = now() - typingStart;
  const cpu = process.cpuUsage(cpuBefore);
  const typed = Object.assign({}, ...stopped.map((s) => s.typed)) as Record<string, number>;

  // Convergence of text and cursors.
  const check = async () =>
    (await Promise.all(threads.map((t) => t.ask({ type: "check", typed }, "checked")))).flatMap(
      (c) => c.replicas,
    );
  const settleDeadline = now() + opts.settleS * 1000;
  let replicas = await check();
  let result = convergence(replicas);
  while ((result.complete < shares.length || result.cursorGaps > 0) && now() < settleDeadline) {
    await sleep(250);
    replicas = await check();
    result = convergence(replicas);
  }
  const after = await snapshot();
  const resourceReport = await resources.stop();
  const outputs: WorkerResults[] = (
    await Promise.all(threads.map((t) => t.ask({ type: "results" }, "results")))
  ).map((r) => r.results);

  // Latencies: deliveries joined with the writers' typing times.
  const typedAt = new Map<string, Float64Array>();
  for (const output of outputs) {
    for (const [key, times] of Object.entries(output.typed)) typedAt.set(key, times);
    for (const [reason, count] of output.failures) fail(reason, count);
    counters.rateLimited += output.rateLimited;
  }
  let stormReport: Record<string, unknown> | null = null;
  let stormEnd = Number.POSITIVE_INFINITY;
  if (plan.storm && stormAt !== null) {
    const start = stormAt;
    const affected = outputs.flatMap((o) => o.storm).filter((r) => r.wasSynced);
    // A client that kept its connection (a Valkey or MongoDB blip) counts as resynced at once.
    const times = affected
      .filter((r) => r.resyncedAt !== null || r.lostAt === null)
      .map((r) => (r.resyncedAt === null ? 0 : r.resyncedAt - start));
    stormEnd = times.length === affected.length ? start + Math.max(0, ...times) : now();
    stormReport = {
      kind: plan.storm.kind,
      atS: plan.storm.atS,
      command: plan.storm.command ?? null,
      commandExit: command?.exitCode ?? null,
      commandMs: command ? Math.round(command.ms) : null,
      clients: affected.length,
      lost: affected.filter((r) => r.lostAt !== null).length,
      resynced: times.length,
      within5s: times.filter((t) => t <= 5000).length,
      reconnectMs: summarize(times),
    };
  }

  const shareGroup = shares.map((s) => s.group);
  type Samples = { steady: number[]; storm: number[]; awareness: number[]; published: number };
  const perGroup = new Map<string, Samples>();
  const groupEntry = (name: string) => {
    let entry = perGroup.get(name);
    if (!entry) {
      entry = { steady: [], storm: [], awareness: [], published: 0 };
      perGroup.set(name, entry);
    }
    return entry;
  };
  for (const output of outputs) {
    for (let i = 0; i < output.rxAt.length; i++) {
      const shareIndex = output.rxShare[i] as number;
      const times = typedAt.get(`${shareIndex}:${output.rxWriter[i]}`);
      const sentAt = times?.[output.rxSeq[i] as number];
      if (sentAt === undefined) continue;
      const entry = groupEntry(shareGroup[shareIndex] ?? "?");
      const ms = (output.rxAt[i] as number) - sentAt;
      if (stormAt !== null && sentAt >= stormAt && sentAt <= stormEnd) entry.storm.push(ms);
      else entry.steady.push(ms);
    }
    for (const [name, group] of Object.entries(output.groups)) {
      const entry = groupEntry(name);
      for (const ms of group.awarenessMs) entry.awareness.push(ms);
      entry.published += group.awarenessPublished;
    }
  }

  const groups: Record<string, unknown> = {};
  let allEdits: number[] = [];
  let allAwareness: number[] = [];
  let stormEdits: number[] = [];
  let typedTotal = 0;
  let expectedTotal = 0;
  for (const group of plan.groups) {
    const entry = groupEntry(group.name);
    const indexes = shares.flatMap((s, i) => (s.group === group.name ? [i] : []));
    let typedInGroup = 0;
    let expected = 0;
    for (const index of indexes) {
      const markers = Object.entries(typed)
        .filter(([key]) => key.startsWith(`${index}:`))
        .reduce((n, [, count]) => n + count, 0);
      const live = replicas.filter((r) => r.shareIndex === index && r.synced).length;
      typedInGroup += markers;
      expected += Math.max(0, live - 1) * markers;
    }
    typedTotal += typedInGroup;
    expectedTotal += expected;
    // Hundreds of thousands of samples: too many for spread arguments.
    allEdits = allEdits.concat(entry.steady);
    allAwareness = allAwareness.concat(entry.awareness);
    stormEdits = stormEdits.concat(entry.storm);
    groups[group.name] = {
      kind: group.kind,
      shares: indexes.length,
      clients: jobs.filter((j) => j.group === group.name).length,
      markersTyped: typedInGroup,
      deliveries: { expected, received: entry.steady.length + entry.storm.length },
      editLatencyMs: summarize(entry.steady),
      awarenessPublished: entry.published,
      awarenessReceived: entry.awareness.length,
      awarenessLatencyMs: summarize(entry.awareness),
      convergence: convergence(replicas, indexes),
    };
  }

  const syncedClients = replicas.filter((r) => r.synced).length;
  const errorCount = [...failures.values()].reduce((a, b) => a + b, 0);
  const editLatency = summarize(allEdits);
  const awarenessLatency = summarize(allAwareness);
  const seconds = typingMs / 1000;
  const generator = {
    threads: threadCount,
    cpuCores: Math.round(((cpu.user + cpu.system) / 1e3 / typingMs) * 100) / 100,
    eventLoopLagMs: {
      p50: Math.max(...outputs.map((o) => o.lagMs.p50)),
      p99: Math.max(...outputs.map((o) => o.lagMs.p99)),
      max: Math.max(...outputs.map((o) => o.lagMs.max)),
    },
  };
  // The collab metrics URL is one address behind Caddy: with several replicas each scrape may reach
  // a different process, and counters (or peaks) of different processes cannot be told from a
  // restart. Counter rates and peaks are then unsupported; the docker figures cover all replicas.
  const collabReplicas = resourceReport.services.collab?.replicas ?? null;
  const collabMetricsSupported = collabReplicas === null || collabReplicas <= 1;
  const peak = (name: string) =>
    collabMetricsSupported
      ? Math.max(0, ...[...samples, after].map((s) => s.collab?.[name] ?? 0))
      : Number.NaN;
  const series = [atStart, ...samples, after];
  const perSecond = (value: number | null) =>
    value === null ? null : Math.round((value / seconds) * 10) / 10;
  const collabRate = (name: string) =>
    collabMetricsSupported
      ? perSecond(
          increase(
            series.map((x) => x.collab),
            name,
          ),
        )
      : null;
  const server = {
    collabReplicas,
    collabMetricsSupported,
    collabCpuCores: collabRate("gachipad_collab_process_cpu_seconds_total"),
    apiCpuCores: perSecond(
      increase(
        series.map((x) => x.api),
        "gachipad_api_process_cpu_seconds_total",
      ),
    ),
    updatesPerS: collabRate("gachipad_collab_updates_total"),
    wsMessagesPerS: collabRate("gachipad_collab_ws_messages_sent_total"),
    wsBytesPerS: collabRate("gachipad_collab_ws_bytes_sent_total"),
    flushesPerS: collabRate("gachipad_collab_flush_seconds_count"),
    awarenessDropped: collabMetricsSupported
      ? increase(
          series.map((x) => x.collab),
          "gachipad_collab_awareness_dropped_total",
        )
      : null,
    collabLagP99Ms: nullIfNaN(
      Math.round(peak("gachipad_collab_nodejs_eventloop_lag_p99_seconds") * 1e4) / 10,
    ),
    collabLagMaxMs: nullIfNaN(
      Math.round(peak("gachipad_collab_nodejs_eventloop_lag_max_seconds") * 1e4) / 10,
    ),
    collabRssPeakMiB: nullIfNaN(
      Math.round((peak("gachipad_collab_process_resident_memory_bytes") / 1024 ** 2) * 10) / 10,
    ),
    collabHeapPeakMiB: nullIfNaN(
      Math.round((peak("gachipad_collab_nodejs_heap_size_used_bytes") / 1024 ** 2) * 10) / 10,
    ),
  };

  // Server budgets (docs/OPERATIONS.md §11.1) are checked when container sampling was asked for
  // (--docker-project); a service with no samples then fails. Without it they are not checked.
  const budgets = opts.dockerProject ? checkBudgets(resourceReport.services, attempted) : null;

  const targets = {
    editP95Ms: { limit: 100, value: editLatency.p95, ok: editLatency.p95 < 100 },
    editP99Ms: { limit: 250, value: editLatency.p99, ok: editLatency.p99 < 250 },
    awarenessP95Ms: { limit: 100, value: awarenessLatency.p95, ok: awarenessLatency.p95 <= 100 },
    lostEdits: { limit: 0, value: result.missing, ok: result.missing === 0 },
    duplicatedEdits: { limit: 0, value: result.duplicated, ok: result.duplicated === 0 },
    converged: {
      limit: shares.length,
      value: result.complete,
      ok: result.complete === shares.length && shares.length > 0,
    },
    cursorsConverged: { limit: 0, value: result.cursorGaps, ok: result.cursorGaps === 0 },
    errors: { limit: 0, value: errorCount, ok: errorCount === 0 },
    ...budgets,
    ...(stormReport
      ? {
          resyncedWithin5s: {
            limit: stormReport.clients as number,
            value: stormReport.within5s as number,
            ok: stormReport.within5s === stormReport.clients,
          },
        }
      : {}),
  };
  const ok = Object.values(targets).every((t) => t.ok) && syncedClients === attempted;
  const resourcesChecked = budgets !== null;

  const report = {
    scenario: plan.scenario,
    label: opts.label,
    startedAt,
    url: opts.url,
    plan,
    typingSeconds: seconds,
    clients: { attempted, synced: syncedClients, successRate: syncedClients / attempted },
    connectMs: connectLatency,
    markersTyped: typedTotal,
    deliveries: {
      expected: expectedTotal,
      received: allEdits.length + stormEdits.length,
      ratio: expectedTotal === 0 ? 1 : (allEdits.length + stormEdits.length) / expectedTotal,
    },
    latencyMs: editLatency,
    stormEditLatencyMs: stormReport ? summarize(stormEdits) : null,
    awarenessLatencyMs: awarenessLatency,
    groups,
    convergence: {
      shares: shares.length,
      converged: result.converged,
      complete: result.complete,
      missingMarkers: result.missing,
      duplicatedMarkers: result.duplicated,
      cursorGaps: result.cursorGaps,
      notConverged: result.bad,
      ok: result.complete === shares.length,
    },
    storm: stormReport,
    errors: {
      total: errorCount,
      byReason: Object.fromEntries(failures),
      rateLimitedRetries: counters.rateLimited,
    },
    generator,
    server,
    resources: resourceReport,
    metrics: { before, atStart, samples, after },
    targets,
    resourcesChecked,
    ok,
  };

  const outDir = opts.outDir ?? fileURLToPath(new URL("../../../.box-out/perf/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  const file = `${outDir.replace(/\/$/, "")}/${plan.scenario}-${opts.label}-${stamp}.json`;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

  const f = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(1));
  const rows: [string, string][] = [
    ["shares", String(shares.length)],
    [
      "clients synced",
      `${syncedClients}/${attempted} (${(report.clients.successRate * 100).toFixed(2)}%)`,
    ],
    ["connect+sync p50/p95 ms", `${f(connectLatency.p50)} / ${f(connectLatency.p95)}`],
    ["markers typed", String(typedTotal)],
    [
      "deliveries",
      `${report.deliveries.received}/${expectedTotal} (${(report.deliveries.ratio * 100).toFixed(2)}%)`,
    ],
    [
      "edit p50/p95/p99/max ms",
      `${f(editLatency.p50)} / ${f(editLatency.p95)} / ${f(editLatency.p99)} / ${f(editLatency.max)}`,
    ],
    [
      "cursor p50/p95/p99 ms",
      `${f(awarenessLatency.p50)} / ${f(awarenessLatency.p95)} / ${f(awarenessLatency.p99)} (${awarenessLatency.count} seen)`,
    ],
    [
      "convergence",
      `${result.complete}/${shares.length} shares, missing ${result.missing}, duplicated ${result.duplicated}, cursor gaps ${result.cursorGaps}`,
    ],
    ["errors", String(errorCount)],
    ["rate-limited retries", String(counters.rateLimited)],
    [
      "generator cpu / lag p99",
      `${generator.cpuCores} cores in ${threadCount} threads / ${generator.eventLoopLagMs.p99} ms`,
    ],
    [
      "collab cpu / lag p99 / rss",
      `${f(server.collabCpuCores)} cores / ${f(server.collabLagP99Ms)} ms / ${f(server.collabRssPeakMiB)} MiB`,
    ],
    [
      "collab ws msgs/s / KiB/s",
      `${f(server.wsMessagesPerS)} / ${f(server.wsBytesPerS === null ? null : server.wsBytesPerS / 1024)}`,
    ],
  ];
  if (stormReport) {
    const r = stormReport.reconnectMs as ReturnType<typeof summarize>;
    rows.push([
      "storm resynced (<=5s) / p95 / max ms",
      `${stormReport.resynced}/${stormReport.clients} (${stormReport.within5s}) / ${f(r.p95)} / ${f(r.max)}`,
    ]);
    const s = report.stormEditLatencyMs;
    if (s) {
      rows.push(["edits typed in the storm p95/max ms", `${f(s.p95)} / ${f(s.max)} (${s.count})`]);
    }
  }
  for (const [name, usage] of Object.entries(resourceReport.services)) {
    rows.push([
      `docker ${name}${usage.replicas > 1 ? ` x${usage.replicas} summed` : ""} cpu avg/peak %, mem peak`,
      `${usage.cpuAvg} / ${usage.cpuPeak}, ${usage.memPeakMiB} MiB`,
    ]);
  }
  if (resourceReport.host) {
    const host = resourceReport.host;
    rows.push(["host cpu avg/peak %", `${host.cpuAvg} / ${host.cpuPeak} of ${host.cores} cores`]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  console.log("");
  for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`);
  for (const [reason, count] of failures) console.log(`  error x${count}: ${reason}`);
  for (const [name, target] of Object.entries(targets)) {
    if (!target.ok)
      console.log(
        `  target missed: ${name} = ${target.value ?? "no data"} (limit ${target.limit})`,
      );
  }
  if (!collabMetricsSupported) {
    console.log(
      `  collab runs ${collabReplicas} replicas: counter rates, event-loop lag and RSS from /metrics/collab are unsupported (shown as -); the docker rows above add the replicas up`,
    );
  }
  if (!resourcesChecked) {
    console.log(
      opts.dockerProject
        ? `  server resource budgets: none documented for ${attempted} clients`
        : "  server resource budgets: not checked (no --docker-project); this verdict is protocol and latency only",
    );
  }
  console.log(`\nresult: ${ok ? "OK" : "FAILED"}  (${file})`);

  // Cleanup.
  await Promise.all(threads.map((t) => t.ask({ type: "close" }, "closed")));
  await Promise.all(threads.map((t) => t.worker.terminate()));
  if (!opts.keep) {
    await pool(shares, opts.concurrency, async (share) => {
      await share.owner.call("DELETE", `/api/shares/${share.id}`).catch(() => undefined);
    });
  }
  await agent.close();
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
