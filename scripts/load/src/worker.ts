// One client thread of the load test (main.ts starts several, so the generator's own event loop
// does not become the bottleneck it measures). It runs the clients it is given and answers the
// coordinator's phase messages; see protocol.ts.
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { ApiClient, createAgent } from "./api.js";
import {
  type ClientJob,
  type FromWorker,
  now,
  type Replica,
  type ToWorker,
  type WorkerConfig,
  type WorkerResults,
} from "./protocol.js";
import { marker, markersIn } from "./stats.js";

interface Client {
  job: ClientJob;
  doc: Y.Doc;
  text: Y.Text;
  api: ApiClient;
  provider?: HocuspocusProvider;
  socket?: HocuspocusProviderWebsocket;
  synced: boolean;
  everSynced: boolean;
  /** Typing time of every marker, by seq. */
  typed: number[];
  /** Next awareness stamp; the last one published is `awarenessSeq - 1`. */
  awarenessSeq: number;
  /** Highest awareness stamp seen, per sender key. */
  seen: Map<string, number>;
  user: Record<string, unknown>;
  wasSynced: boolean;
  lostAt: number | null;
  resyncedAt: number | null;
}

/** Awareness stamp: sender, sequence, time sent. */
interface Stamp {
  k: string;
  s: number;
  t: number;
}

/** The editor's reconnect policy (apps/web/src/lib/collab/socket.ts). */
const RECONNECT = {
  maxAttempts: 0,
  delay: 400,
  factor: 1.6,
  minDelay: 200,
  maxDelay: 4000,
  jitter: true,
  messageReconnectTimeout: 30_000,
} as const;

const port = parentPort;
if (!port) throw new Error("worker.ts runs as a worker thread");
const config = workerData as WorkerConfig;
const wsBase = config.url.replace(/^http/, "ws");
const clients: Client[] = [];
const sockets = new Map<string, HocuspocusProviderWebsocket>();
const failures = new Map<string, number>();
const awareness = new Map<string, { ms: number[]; published: number }>();
const rx = {
  share: [] as number[],
  writer: [] as number[],
  seq: [] as number[],
  at: [] as number[],
};
let rateLimited = 0;
let agent: ReturnType<typeof createAgent> | null = null;
let typing = false;
let stormAt: number | null = null;
const timers: NodeJS.Timeout[] = [];
const loop = monitorEventLoopDelay({ resolution: 1 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (reason: string) => failures.set(reason, (failures.get(reason) ?? 0) + 1);
const send = (message: FromWorker, transfer: ArrayBuffer[] = []) =>
  port.postMessage(message, transfer);

function groupAwareness(name: string) {
  let entry = awareness.get(name);
  if (!entry) {
    entry = { ms: [], published: 0 };
    awareness.set(name, entry);
  }
  return entry;
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  await Promise.all(workers);
}

function observe(client: Client) {
  const { shareIndex } = client.job;
  client.text.observe((event) => {
    if (event.transaction.local) return;
    const at = now();
    for (const op of event.delta) {
      if (typeof op.insert !== "string") continue;
      for (const [writer, seq] of markersIn(op.insert)) {
        rx.share.push(shareIndex);
        rx.writer.push(writer);
        rx.seq.push(seq);
        rx.at.push(at);
      }
    }
  });
}

function observeAwareness(client: Client) {
  const states = client.provider?.awareness;
  if (!states) return;
  const group = groupAwareness(client.job.group);
  states.on(
    "update",
    ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
      if (origin === "local") return;
      const at = now();
      const all = states.getStates();
      for (const id of [...added, ...updated]) {
        const stamp = (all.get(id) as { load?: Stamp } | undefined)?.load;
        if (!stamp || typeof stamp.s !== "number" || stamp.k === client.job.key) continue;
        if (stamp.s <= (client.seen.get(stamp.k) ?? -1)) continue;
        client.seen.set(stamp.k, stamp.s);
        group.ms.push(at - stamp.t);
      }
    },
  );
}

/** Moves this client's cursor to `index`, the way the editor's awareness bridge does. */
function publishCursor(client: Client, index: number) {
  const states = client.provider?.awareness;
  if (!states || !client.everSynced) return;
  const position = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(client.text, index),
  );
  states.setLocalState({
    user: client.user,
    fileId: "main",
    cursor: { anchor: position, head: position },
    viewport: { fromLine: 1, toLine: 40 },
    load: { k: client.job.key, s: client.awarenessSeq++, t: now() } satisfies Stamp,
  });
  groupAwareness(client.job.group).published++;
}

function socketFor(job: ClientJob): HocuspocusProviderWebsocket {
  const create = () =>
    new HocuspocusProviderWebsocket({
      url: `${wsBase}/collab?doc=${job.shareId}`,
      WebSocketPolyfill: WebSocket,
      ...RECONNECT,
    });
  if (job.socketKey === null) return create();
  let socket = sockets.get(job.socketKey);
  if (!socket) {
    socket = create();
    sockets.set(job.socketKey, socket);
  }
  return socket;
}

async function connect(job: ClientJob, connectMs: number[]): Promise<void> {
  const started = now();
  const doc = new Y.Doc();
  if (!agent) throw new Error("no agent");
  const client: Client = {
    job,
    doc,
    text: doc.getText("file:main"),
    api: new ApiClient(config.url, agent, () => rateLimited++, job.cookie ?? ""),
    synced: false,
    everSynced: false,
    typed: [],
    awarenessSeq: 0,
    seen: new Map(),
    user: {},
    wasSynced: false,
    lostAt: null,
    resyncedAt: null,
  };
  clients.push(client);
  try {
    const session = await client.api.call<{ clientId: string; color: string }>(
      "GET",
      "/api/session",
    );
    if (session.status !== 200) throw new Error(`session ${session.status}`);
    client.user = { clientId: session.json.clientId, name: "load", color: session.json.color };
    // Every (re)connect asks for a fresh token, as the editor does.
    const token = async () => {
      const joined = await client.api.call<{ token: string; role: string }>(
        "POST",
        `/api/shares/${job.shareId}/join`,
        job.body,
      );
      if (joined.status !== 200) {
        fail(`join ${joined.status}`);
        return "";
      }
      if (job.roles.length > 0 && !job.roles.includes(joined.json.role)) {
        fail(`role ${joined.json.role}`);
      }
      return joined.json.token;
    };

    let resolveSynced!: () => void;
    let rejectSynced!: (error: Error) => void;
    const synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
    });
    observe(client);
    const socket = socketFor(job);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: job.shareId,
      document: doc,
      token,
      onSynced: ({ state }) => {
        if (!state) return;
        client.synced = true;
        client.everSynced = true;
        if (stormAt !== null && client.lostAt !== null && client.resyncedAt === null) {
          client.resyncedAt = now();
        }
        resolveSynced();
      },
      onAuthenticationFailed: ({ reason }) => {
        if (client.everSynced) fail(`reauth ${reason}`);
        rejectSynced(new Error(`auth ${reason}`));
      },
      onDisconnect: () => {
        client.synced = false;
        if (stormAt !== null && client.lostAt === null) client.lostAt = now();
      },
    });
    provider.attach();
    client.provider = provider;
    if (job.socketKey === null) client.socket = socket;
    observeAwareness(client);
    await Promise.race([
      synced,
      sleep(config.connectTimeoutS * 1000).then(() => {
        throw new Error("sync timeout");
      }),
    ]);
    connectMs.push(now() - started);
  } catch (error) {
    fail(`connect: ${(error as Error).message}`);
  }
}

function startTyping() {
  typing = true;
  for (const client of clients) {
    if (!client.everSynced || client.job.perSecond <= 0) continue;
    const { writer } = client.job;
    const interval = 1000 / client.job.perSecond;
    const tick =
      writer !== null
        ? () => {
            const seq = client.typed.length;
            client.typed.push(now());
            client.doc.transact(() => client.text.insert(client.text.length, marker(writer, seq)));
            publishCursor(client, client.text.length);
          }
        : () => {
            if (client.synced) {
              publishCursor(client, Math.floor(Math.random() * (client.text.length + 1)));
            }
          };
    const startTimer = setTimeout(() => {
      const timer = setInterval(() => {
        // Writers keep typing while disconnected, like the editor; the edits merge on reconnect.
        if (typing && client.everSynced) tick();
      }, interval);
      timers.push(timer);
    }, Math.random() * interval);
    timers.push(startTimer);
  }
}

function storm(kind: "drop" | "restart", at: number) {
  stormAt = at;
  for (const client of clients) {
    client.wasSynced = client.synced;
    client.lostAt = null;
    client.resyncedAt = null;
  }
  if (kind !== "drop") return;
  const all = new Set([...clients.map((c) => c.socket), ...sockets.values()]);
  for (const socket of all) (socket?.webSocket as WebSocket | null | undefined)?.terminate();
}

function typedCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const client of clients) {
    if (client.job.writer === null) continue;
    out[`${client.job.shareIndex}:${client.job.writer}`] = client.typed.length;
  }
  return out;
}

function replicas(typed: Record<string, number>): Replica[] {
  return clients.map((client) => {
    const text = client.text.toString();
    const counts = new Map<string, number>();
    for (const [w, s] of markersIn(text)) {
      const key = `${w}:${s}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let missing = 0;
    let duplicated = 0;
    const prefix = `${client.job.shareIndex}:`;
    for (const [writerKey, count] of Object.entries(typed)) {
      if (!writerKey.startsWith(prefix)) continue;
      const writer = writerKey.slice(prefix.length);
      for (let seq = 0; seq < count; seq++) {
        const n = counts.get(`${writer}:${seq}`) ?? 0;
        if (n === 0) missing++;
        if (n > 1) duplicated++;
      }
    }
    return {
      key: client.job.key,
      shareIndex: client.job.shareIndex,
      synced: client.synced,
      hash: createHash("sha1").update(text).digest("hex"),
      length: text.length,
      missing,
      duplicated,
      awarenessLast: client.awarenessSeq - 1,
      seen: [...client.seen],
    };
  });
}

function results(): { results: WorkerResults; transfer: ArrayBuffer[] } {
  const typed: Record<string, Float64Array> = {};
  for (const client of clients) {
    if (client.job.writer === null) continue;
    typed[`${client.job.shareIndex}:${client.job.writer}`] = Float64Array.from(client.typed);
  }
  const groups: WorkerResults["groups"] = {};
  for (const [name, entry] of awareness) {
    groups[name] = {
      awarenessMs: Float64Array.from(entry.ms),
      awarenessPublished: entry.published,
    };
  }
  const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  const out: WorkerResults = {
    rxShare: Float64Array.from(rx.share),
    rxWriter: Float64Array.from(rx.writer),
    rxSeq: Float64Array.from(rx.seq),
    rxAt: Float64Array.from(rx.at),
    typed,
    groups,
    storm: clients.map((c) => ({
      key: c.job.key,
      wasSynced: c.wasSynced,
      lostAt: c.lostAt,
      resyncedAt: c.resyncedAt,
    })),
    failures: [...failures],
    rateLimited,
    lagMs: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
  };
  const transfer = [
    out.rxShare.buffer,
    out.rxWriter.buffer,
    out.rxSeq.buffer,
    out.rxAt.buffer,
    ...Object.values(typed).map((a) => a.buffer),
    ...Object.values(groups).map((g) => g.awarenessMs.buffer),
  ] as ArrayBuffer[];
  return { results: out, transfer };
}

port.on("message", (message: ToWorker) => {
  void (async () => {
    switch (message.type) {
      case "connect": {
        agent = createAgent(Math.min(256, Math.max(8, message.jobs.length)));
        const connectMs: number[] = [];
        await pool(message.jobs, config.concurrency, (job) => connect(job, connectMs));
        send({ type: "connected", synced: clients.filter((c) => c.synced).length, connectMs });
        return;
      }
      case "start":
        loop.reset();
        loop.enable();
        startTyping();
        send({ type: "started" });
        return;
      case "storm":
        storm(message.kind, message.at);
        send({ type: "stormed" });
        return;
      case "stop":
        typing = false;
        for (const timer of timers) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        loop.disable();
        send({ type: "stopped", typed: typedCounts() });
        return;
      case "check":
        send({ type: "checked", replicas: replicas(message.typed) });
        return;
      case "results": {
        const { results: out, transfer } = results();
        send({ type: "results", results: out }, transfer);
        return;
      }
      case "close":
        for (const client of clients) {
          client.provider?.destroy();
          client.socket?.destroy();
        }
        for (const socket of sockets.values()) socket.destroy();
        await agent?.close();
        send({ type: "closed" });
        return;
    }
  })().catch((error) => {
    console.error("load worker:", error);
    process.exit(2);
  });
});
