// Load test for the collab path (docs/PLAN.md 4.2). No k6 (AGPL): plain Node clients.
//
//   pnpm load -- --shares 100 --writers 5 --viewers 20 --duration 60 --url http://host
//
// Per share: the owner and (writers - 1) editors type markers at a fixed rate, viewers only read.
// Latency is measured per delivery, from the moment a writer inserts a marker to the moment another
// client's Y.Text observes it (one process, one clock). At the end every client of a share must hold
// the same text containing every marker that was typed.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { ApiClient, createAgent } from "./api.js";
import { type Options, parseOptions, USAGE } from "./args.js";
import { marker, markersIn, metricValue, summarize } from "./stats.js";

interface Share {
  index: number;
  id: string;
  editKey: string;
  owner: ApiClient;
  clients: Client[];
  /** `<writer>:<seq>` -> performance.now() when it was typed. */
  sent: Map<string, number>;
}

interface Client {
  share: Share;
  /** Index among the share's writers, or null for a viewer. */
  writer: number | null;
  doc: Y.Doc;
  text: Y.Text;
  provider?: HocuspocusProvider;
  socket?: HocuspocusProviderWebsocket;
  synced: boolean;
  nextSeq: number;
}

const options = parseOptions(process.argv.slice(2));
if (!options) {
  console.log(USAGE);
  process.exit(0);
}
const opts: Options = options;

const wsBase = opts.url.replace(/^http/, "ws");
const agent = createAgent(Math.min(256, opts.concurrency * 2));
const counters = { rateLimited: 0, deliveries: 0, expectedDeliveries: 0 };
const failures = new Map<string, number>();
const latencies: number[] = [];
const connectTimes: number[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);
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
    "codesh_http_request_duration_seconds_count",
    "codesh_shares_created_total",
    "codesh_rate_limited_total",
    "codesh_sse_connections",
    "codesh_api_process_cpu_seconds_total",
    "codesh_api_process_resident_memory_bytes",
    "codesh_api_nodejs_eventloop_lag_p99_seconds",
  ],
  collab: [
    "codesh_collab_connections",
    "codesh_collab_documents_loaded",
    "codesh_collab_updates_total",
    "codesh_collab_flush_seconds_count",
    "codesh_collab_flush_seconds_sum",
    "codesh_collab_flush_errors_total",
    "codesh_collab_slow_client_closes_total",
    "codesh_collab_refused_too_large_total",
    "codesh_collab_process_cpu_seconds_total",
    "codesh_collab_process_resident_memory_bytes",
    "codesh_collab_nodejs_eventloop_lag_p99_seconds",
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

async function createShare(index: number, stamp: string): Promise<Share | null> {
  const owner = newApi();
  try {
    const session = await owner.call("GET", "/api/session");
    if (session.status !== 200) throw new Error(`session ${session.status}`);
    const created = await owner.call<{ id: string }>("POST", "/api/shares", {
      title: `load-${stamp}-${index}`,
      files: [{ path: "main.txt", content: "// codesh load test\n" }],
    });
    if (created.status !== 200) throw new Error(`create ${created.status}`);
    const { id } = created.json;
    // Viewers join with the default access, editors with the edit key.
    const patched = await owner.call("PATCH", `/api/shares/${id}`, { access: { default: "view" } });
    if (patched.status !== 200) throw new Error(`patch ${patched.status}`);
    const view = await owner.call<{ access?: { editKey: string } }>("GET", `/api/shares/${id}`);
    const editKey = view.json.access?.editKey;
    if (!editKey) throw new Error("no edit key");
    return { index, id, editKey, owner, clients: [], sent: new Map() };
  } catch (error) {
    fail(`create share: ${(error as Error).message}`);
    return null;
  }
}

function observe(client: Client) {
  client.text.observe((event) => {
    if (event.transaction.local) return;
    const now = performance.now();
    for (const op of event.delta) {
      if (typeof op.insert !== "string") continue;
      for (const [writer, seq] of markersIn(op.insert)) {
        const sentAt = client.share.sent.get(`${writer}:${seq}`);
        if (sentAt === undefined) continue;
        latencies.push(now - sentAt);
        counters.deliveries++;
      }
    }
  });
}

async function connect(share: Share, writer: number | null, isOwner: boolean): Promise<void> {
  const started = performance.now();
  const doc = new Y.Doc();
  const client: Client = {
    share,
    writer,
    doc,
    text: doc.getText("file:main"),
    synced: false,
    nextSeq: 0,
  };
  share.clients.push(client);
  try {
    const api = isOwner ? share.owner : newApi();
    if (!isOwner) {
      const session = await api.call("GET", "/api/session");
      if (session.status !== 200) throw new Error(`session ${session.status}`);
    }
    const joined = await api.call<{ token: string; role: string }>(
      "POST",
      `/api/shares/${share.id}/join`,
      writer !== null && !isOwner ? { editKey: share.editKey } : {},
    );
    if (joined.status !== 200) throw new Error(`join ${joined.status}`);
    const wantRole = writer === null ? "view" : isOwner ? "owner" : "edit";
    if (joined.json.role !== wantRole) throw new Error(`role ${joined.json.role}`);

    let resolveSynced!: () => void;
    let rejectSynced!: (error: Error) => void;
    const synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });
    observe(client);
    const socket = new HocuspocusProviderWebsocket({
      url: `${wsBase}/collab?doc=${share.id}`,
      WebSocketPolyfill: WebSocket,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: share.id,
      document: doc,
      token: joined.json.token,
      onSynced: () => {
        client.synced = true;
        resolveSynced();
      },
      onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`auth ${reason}`)),
      onDisconnect: () => {
        client.synced = false;
      },
    });
    provider.attach();
    client.provider = provider;
    client.socket = socket;
    await Promise.race([
      synced,
      sleep(opts.connectTimeoutS * 1000).then(() => {
        throw new Error("sync timeout");
      }),
    ]);
    connectTimes.push(performance.now() - started);
  } catch (error) {
    fail(`connect: ${(error as Error).message}`);
  }
}

// --- run -------------------------------------------------------------------------------------

function tokensSent(share: Share) {
  return share.sent.size;
}

function convergence(shares: Share[]) {
  let converged = 0;
  let complete = 0;
  const bad: string[] = [];
  for (const share of shares) {
    const live = share.clients.filter((client) => client.synced);
    const texts = new Set(live.map((client) => client.text.toString()));
    const same = live.length > 0 && texts.size === 1;
    let all = false;
    if (same) {
      const present = new Set(markersIn([...texts][0] as string).map(([w, s]) => `${w}:${s}`));
      all = [...share.sent.keys()].every((key) => present.has(key));
    }
    if (same) converged++;
    if (same && all) complete++;
    else bad.push(share.id);
  }
  return { converged, complete, bad };
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();
  console.log(
    `load: ${opts.shares} shares x (${opts.writers} writers + ${opts.viewers} viewers) for ${opts.durationS}s at ${opts.rate}/s against ${opts.url}`,
  );
  const before = await snapshot();

  const indexes = Array.from({ length: opts.shares }, (_, i) => i);
  const created: Share[] = [];
  await pool(indexes, opts.concurrency, async (index) => {
    const share = await createShare(index, stamp);
    if (share) created.push(share);
  });
  created.sort((a, b) => a.index - b.index);
  console.log(`load: created ${created.length}/${opts.shares} shares`);

  const jobs = created.flatMap((share) => [
    ...Array.from({ length: opts.writers }, (_, k) => ({ share, writer: k, owner: k === 0 })),
    ...Array.from({ length: opts.viewers }, () => ({ share, writer: null, owner: false })),
  ]);
  const attempted = jobs.length;
  await pool(jobs, opts.concurrency, (job) => connect(job.share, job.writer, job.owner));
  const connected = created.reduce((n, s) => n + s.clients.filter((c) => c.synced).length, 0);
  console.log(`load: ${connected}/${attempted} clients synced; typing for ${opts.durationS}s`);

  // Typing.
  const samples: Snapshot[] = [];
  const timers: NodeJS.Timeout[] = [];
  const typingStart = performance.now();
  let typing = true;
  const interval = 1000 / opts.rate;
  for (const share of created) {
    for (const client of share.clients) {
      if (client.writer === null || !client.synced) continue;
      const writer = client.writer;
      const startTimer = setTimeout(() => {
        const timer = setInterval(() => {
          if (!typing || !client.synced) return;
          const seq = client.nextSeq++;
          const token = marker(writer, seq);
          share.sent.set(`${writer}:${seq}`, performance.now());
          client.doc.transact(() => client.text.insert(client.text.length, token));
        }, interval);
        timers.push(timer);
      }, Math.random() * interval);
      timers.push(startTimer);
    }
  }
  const sampler = setInterval(() => {
    void snapshot().then((s) => samples.push(s));
  }, opts.sampleS * 1000);
  await sleep(opts.durationS * 1000);
  typing = false;
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  clearInterval(sampler);
  const typingMs = performance.now() - typingStart;

  // Convergence.
  const settleDeadline = performance.now() + opts.settleS * 1000;
  let result = convergence(created);
  while (result.complete < created.length && performance.now() < settleDeadline) {
    await sleep(250);
    result = convergence(created);
  }
  for (const share of created) {
    const live = share.clients.filter((client) => client.synced).length;
    counters.expectedDeliveries += Math.max(0, live - 1) * tokensSent(share);
  }
  const after = await snapshot();

  // Report.
  const latency = summarize(latencies);
  const connectLatency = summarize(connectTimes);
  const syncedClients = created.reduce((n, s) => n + s.clients.filter((c) => c.synced).length, 0);
  const errorCount = [...failures.values()].reduce((a, b) => a + b, 0);
  const ok =
    result.complete === created.length && created.length === opts.shares && errorCount === 0;

  const report = {
    startedAt,
    options: opts,
    typingSeconds: typingMs / 1000,
    shares: { requested: opts.shares, created: created.length },
    clients: { attempted, synced: syncedClients, successRate: syncedClients / attempted },
    connectMs: connectLatency,
    markersTyped: created.reduce((n, s) => n + tokensSent(s), 0),
    deliveries: {
      expected: counters.expectedDeliveries,
      received: counters.deliveries,
      ratio:
        counters.expectedDeliveries === 0 ? 1 : counters.deliveries / counters.expectedDeliveries,
    },
    latencyMs: latency,
    convergence: {
      shares: created.length,
      converged: result.converged,
      complete: result.complete,
      notConverged: result.bad,
      ok: result.complete === created.length,
    },
    errors: {
      total: errorCount,
      byReason: Object.fromEntries(failures),
      rateLimitedRetries: counters.rateLimited,
    },
    metrics: { before, samples, after },
    ok,
  };

  const outDir = opts.outDir ?? fileURLToPath(new URL("../../../.box-out/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  const file = `${outDir.replace(/\/$/, "")}/load-${stamp}.json`;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);

  const f = (n: number) => n.toFixed(1);
  const rows: [string, string][] = [
    ["shares created", `${created.length}/${opts.shares}`],
    [
      "clients synced",
      `${syncedClients}/${attempted} (${(report.clients.successRate * 100).toFixed(2)}%)`,
    ],
    ["connect+sync p50/p95 ms", `${f(connectLatency.p50)} / ${f(connectLatency.p95)}`],
    ["markers typed", String(report.markersTyped)],
    [
      "deliveries",
      `${counters.deliveries}/${counters.expectedDeliveries} (${(report.deliveries.ratio * 100).toFixed(2)}%)`,
    ],
    ["latency p50 ms", f(latency.p50)],
    ["latency p95 ms", f(latency.p95)],
    ["latency p99 ms", f(latency.p99)],
    ["latency max ms", f(latency.max)],
    [
      "convergence",
      `${result.complete}/${created.length} shares ${report.convergence.ok ? "ok" : "FAILED"}`,
    ],
    ["errors", String(errorCount)],
    ["rate-limited retries", String(counters.rateLimited)],
  ];
  const peak = Math.max(
    ...[before, ...samples, after].map((s) => s.collab?.codesh_collab_connections ?? 0),
  );
  if (after.collab) rows.push(["collab connections (peak)", String(peak)]);
  const width = Math.max(...rows.map(([k]) => k.length));
  console.log("");
  for (const [key, value] of rows) console.log(`${key.padEnd(width)}  ${value}`);
  for (const [reason, count] of failures) console.log(`  error x${count}: ${reason}`);
  console.log(`\nresult: ${ok ? "OK" : "FAILED"}  (${file})`);

  // Cleanup.
  for (const share of created) {
    for (const client of share.clients) {
      client.provider?.destroy();
      client.socket?.destroy();
    }
  }
  if (!opts.keep) {
    await pool(created, opts.concurrency, async (share) => {
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
