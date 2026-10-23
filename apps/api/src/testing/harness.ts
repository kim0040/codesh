import type { SseEvent } from "@codesh/shared";
import { createMemoryStores, type Stores } from "@codesh/storage";
import type { LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import * as Y from "yjs";
import { buildApp } from "../app.js";
import type { LdapAdapter, OidcAdapter } from "../auth/adapters.js";
import type { Config } from "../config.js";
import { Hub } from "../hub.js";
import { createMetrics } from "../metrics.js";

/** Route tests talk to a real Valkey (`pnpm services:up`) and keep MongoDB in memory. */
export const integration = process.env.CODESH_INTEGRATION === "1";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";

/** Each vitest worker gets its own Valkey database, so files can run in parallel. */
const dbIndex = 1 + (Number(process.env.VITEST_POOL_ID ?? 0) % 14);

/** Pub/sub is shared across databases, so networks are unique per harness. */
let harnessCounter = 0;
const netPrefix = () =>
  `10.${20 + ((Number(process.env.VITEST_POOL_ID ?? 0) * 10 + harnessCounter++) % 200)}.${Math.floor(Math.random() * 250)}`;

export interface HarnessOptions {
  config?: Partial<Config>;
  oidc?: OidcAdapter;
  ldap?: LdapAdapter;
  randomCode?: () => string;
  heartbeatMs?: number;
  presenceRefreshMs?: number;
}

export interface Harness {
  app: ReturnType<typeof buildApp>;
  stores: Stores;
  valkey: Redis;
  config: Config;
  /** A browser: its own cookie jar and an IP in the harness's network. */
  client(options?: { ip?: string; hostByte?: number }): Client;
  /** A network group of its own, so presence and nearby lists of other tests do not leak in. */
  network(): { client(hostByte?: number): Client; neighbour(of: Client, hostByte: number): Client };
  /** Base URL of a real listening server (needed for SSE). */
  listen(): Promise<string>;
  /** Collects messages published on a Valkey channel. */
  subscribe(channel: string): Promise<{ messages: unknown[]; stop(): void }>;
  close(): Promise<void>;
}

export type ApiResponse = LightMyRequestResponse;

export class Client {
  private readonly jar = new Map<string, string>();

  constructor(
    private readonly harness: Harness,
    readonly ip: string,
  ) {}

  get cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  async request(
    method: string,
    url: string,
    options: {
      body?: unknown;
      payload?: Buffer | string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<ApiResponse> {
    const response = await this.harness.app.inject({
      method: method as "GET",
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        "x-forwarded-for": this.ip,
        ...(this.jar.size > 0 ? { cookie: this.cookieHeader } : {}),
        ...options.headers,
      },
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
    });
    for (const cookie of response.cookies) this.jar.set(cookie.name, cookie.value);
    return response as ApiResponse;
  }

  get = (url: string, headers?: Record<string, string>) => this.request("GET", url, { headers });
  post = (url: string, body?: unknown) => this.request("POST", url, { body: body ?? {} });
  patch = (url: string, body: unknown) => this.request("PATCH", url, { body });
  put = (url: string, body: unknown, headers?: Record<string, string>) =>
    this.request("PUT", url, { body, headers });
  delete = (url: string) => this.request("DELETE", url);

  /** The client's own id, from `GET /api/session`. */
  async clientId(): Promise<string> {
    return (await this.get("/api/session")).json<{ clientId: string }>().clientId;
  }

  /** Sets a display name so the client shows up in presence lists under it. */
  async named(name: string): Promise<this> {
    await this.patch("/api/session", { name });
    return this;
  }

  /** Opens `GET /api/events` against the listening server. */
  async events(baseUrl: string): Promise<EventStream> {
    await this.get("/api/session");
    return openEventStream(baseUrl, {
      cookie: this.cookieHeader,
      "x-forwarded-for": this.ip,
    });
  }

  async multipart(
    url: string,
    files: { name: string; data: Uint8Array | string; type?: string }[],
  ): Promise<ApiResponse> {
    const form = new FormData();
    for (const file of files) {
      const data = typeof file.data === "string" ? file.data : Buffer.from(file.data);
      form.append("file", new Blob([data], { type: file.type }), file.name);
    }
    const encoded = new Response(form);
    return this.request("POST", url, {
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { "content-type": encoded.headers.get("content-type") as string },
    });
  }
}

export interface ReceivedEvent {
  event: string;
  data: unknown;
}

export interface EventStream {
  status: number;
  headers: Headers;
  events: ReceivedEvent[];
  /** Raw text received so far, comments included. */
  raw(): string;
  /** Resolves when the server ended the stream (or `close()` was called). */
  closed: Promise<void>;
  /** Resolves with the first matching event not returned before. */
  next<T extends SseEvent["event"]>(
    event: T,
    predicate?: (data: Extract<SseEvent, { event: T }>["data"]) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<SseEvent, { event: T }>["data"]>;
  close(): void;
}

export async function openEventStream(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { headers, signal: controller.signal });
  const events: ReceivedEvent[] = [];
  let text = "";
  let cursor = 0;
  const waiters = new Set<() => void>();

  const parse = (frame: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  };

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  void (async () => {
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        buffer += chunk;
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
        }
        for (const wake of waiters) wake();
      }
    } catch {
      // aborted
    }
    markClosed();
  })();

  return {
    status: response.status,
    headers: response.headers,
    events,
    closed,
    raw: () => text,
    next(event, predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          for (let i = cursor; i < events.length; i++) {
            const candidate = events[i] as ReceivedEvent;
            if (candidate.event === event && (!predicate || predicate(candidate.data as never))) {
              cursor = i + 1;
              waiters.delete(check);
              clearTimeout(timer);
              resolve(candidate.data as never);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `no "${event}" event within ${timeoutMs}ms; got ${JSON.stringify(events.map((e) => e.event))}`,
            ),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** Polls until `fn` returns a truthy value, so tests do not sleep for fixed times. */
export async function eventually<T>(
  fn: () => Promise<T> | T,
  timeoutMs = 3000,
): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const valkey = new Redis(VALKEY_URL, { db: dbIndex });
  await valkey.flushdb();
  const subscriber = new Redis(VALKEY_URL);
  const stores = createMemoryStores();
  const config: Config = {
    production: false,
    host: "127.0.0.1",
    port: 0,
    storage: "memory",
    mongoUrl: "",
    valkeyUrl: VALKEY_URL,
    sessionSecret: "s".repeat(40),
    collabSecret: "c".repeat(40),
    adminToken: "admin-token-for-tests",
    trustProxy: ["127.0.0.0/8", "::1/128"],
    publicUrl: "",
    rateLimit: {
      apiPerMinute: 100_000,
      codePerMinute: 100_000,
      createPerMinute: 100_000,
      loginPerMinute: 100_000,
    },
    ...options.config,
  };
  const app = buildApp({
    config,
    stores,
    valkey,
    hub: new Hub(subscriber),
    metrics: createMetrics(),
    oidc: options.oidc,
    ldap: options.ldap,
    randomCode: options.randomCode,
    heartbeatMs: options.heartbeatMs,
    presenceRefreshMs: options.presenceRefreshMs,
    settingsCacheMs: 0,
  });
  await app.ready();

  const prefix = netPrefix();
  let hosts = 10;
  const extra: Redis[] = [];
  const harness: Harness = {
    app,
    stores,
    valkey,
    config,
    client(opts = {}) {
      return new Client(harness, opts.ip ?? `${prefix}.${opts.hostByte ?? hosts++}`);
    },
    network() {
      const own = netPrefix();
      let next = 10;
      const make = (host: number) => new Client(harness, `${own}.${host}`);
      return {
        client: (hostByte) => make(hostByte ?? next++),
        neighbour: (of, hostByte) =>
          new Client(harness, of.ip.split(".").slice(0, 3).concat(String(hostByte)).join(".")),
      };
    },
    async listen() {
      return app.listen({ host: "127.0.0.1", port: 0 });
    },
    async subscribe(channel) {
      const connection = new Redis(VALKEY_URL);
      extra.push(connection);
      const messages: unknown[] = [];
      connection.on("message", (_channel, message) => messages.push(JSON.parse(message)));
      await connection.subscribe(channel);
      return { messages, stop: () => connection.disconnect() };
    },
    async close() {
      await app.close();
      for (const connection of extra) connection.disconnect();
      subscriber.disconnect();
      await valkey.flushdb();
      valkey.disconnect();
    },
  };
  return harness;
}

/** The three-address network of a client, for tests that need two clients in the same /24. */
export const sameNet = (ip: string, host: number) =>
  `${ip.split(".").slice(0, 3).join(".")}.${host}`;

/** The document as collab would load it: newest compact snapshot plus the updates after it. */
export async function storedDoc(stores: Stores, shareId: string): Promise<Y.Doc> {
  const snapshot = await stores.snapshots.latest(shareId, "compact");
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot.state);
  for (const update of await stores.updates.read(shareId, snapshot?.seq ?? 0)) {
    Y.applyUpdate(doc, update.data);
  }
  return doc;
}

export interface Created {
  id: string;
  code: string;
  url: string;
}

export async function createShare(
  client: Client,
  body: Record<string, unknown> = {},
): Promise<Created> {
  const response = await client.post("/api/shares", body);
  if (response.statusCode !== 200) {
    throw new Error(`create share failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<Created>();
}
