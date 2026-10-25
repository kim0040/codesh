import {
  createServer,
  type Server as NetServer,
  type Socket,
  connect as tcpConnect,
} from "node:net";
import {
  COLLAB_COMMAND_TIMEOUT_MS,
  type CollabCommand,
  type CollabCommandReply,
  type CollabTokenPayload,
  channels,
  collabCommandReplySchema,
  generateClientId,
  generateJoinCode,
  generateShareId,
  type PermMessage,
  type Role,
  type ShareRecord,
  signCollabToken,
} from "@gachipad/shared";
import type { Stores } from "@gachipad/storage";
import {
  createTestDatabase,
  mongoAvailable,
  requireService,
  type TestDatabase,
  VALKEY_TEST_URL,
} from "@gachipad/storage/testing";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Redis } from "ioredis";
import WebSocket from "ws";
import * as Y from "yjs";
import type { CollabTimings } from "../collab.js";
import { loadPersisted } from "../persisted-doc.js";
import { type CollabServer, createCollabServer } from "../server.js";

/** Integration test kit: a throwaway database, collab servers and provider clients. */

export const TEST_SECRET = "collab-test-secret";

/** Short timings so tests do not wait for production intervals. */
export const TEST_TIMINGS: Partial<CollabTimings> = {
  unloadDelayMs: 300,
  lockTtlMs: 3000,
  lockRenewMs: 300,
  nearbyThrottleMs: 50,
};

export async function servicesAvailable(): Promise<boolean> {
  const mongo = await mongoAvailable();
  const valkey = await requireService("Valkey", async () => {
    const redis = new Redis(VALKEY_TEST_URL, {
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      await redis.connect();
      await redis.ping();
    } finally {
      redis.disconnect();
    }
  });
  return mongo && valkey;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Client {
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  doc: Y.Doc;
  text: Y.Text;
  clientId: string;
  /** Parsed stateless messages from the server. */
  stateless: unknown[];
  /** Reasons of per-document closes. */
  closes: string[];
  /** Every byte received, for payload inspection. */
  received: Uint8Array[];
  synced: Promise<void>;
  /** Resolves with the denial reason if authentication fails. */
  denied: Promise<string>;
  destroy(): void;
}

export interface ConnectOptions {
  role?: Role;
  clientId?: string;
  token?: string;
}

export class Harness {
  readonly redis = new Redis(VALKEY_TEST_URL);
  private readonly servers: CollabServer[] = [];
  private readonly clients: Client[] = [];

  private constructor(readonly database: TestDatabase) {}

  static async create(): Promise<Harness> {
    return new Harness(await createTestDatabase("gachipad_collab"));
  }

  get stores(): Stores {
    return this.database.stores;
  }

  async createShare(overrides: Partial<ShareRecord> = {}): Promise<ShareRecord> {
    const now = new Date();
    const share: ShareRecord = {
      id: generateShareId(),
      title: "Untitled",
      language: "typescript",
      ownerId: generateClientId(),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      expiresAt: new Date(now.getTime() + 24 * 3600_000),
      saved: false,
      savedBy: [],
      access: {
        default: "edit",
        editKey: "k",
        pinHash: null,
        requireApproval: false,
        nearby: true,
        // General sync fixtures opt into metadata/structure edits; permission tests use strict access.
        allowParticipantRename: true,
        allowParticipantFiles: true,
        allowParticipantLanguage: true,
      },
      bans: [],
      joinCode: generateJoinCode(),
      locked: false,
      sizeBytes: 0,
      ...overrides,
    };
    await this.stores.shares.create(share);
    return share;
  }

  async startServer(
    options: {
      instanceId?: string;
      timings?: Partial<CollabTimings>;
      stores?: Stores;
      valkeyUrl?: string;
    } = {},
  ): Promise<CollabServer> {
    const server = createCollabServer({
      port: 0,
      address: "127.0.0.1",
      quiet: true,
      stores: options.stores ?? this.stores,
      valkeyUrl: options.valkeyUrl ?? VALKEY_TEST_URL,
      secret: TEST_SECRET,
      instanceId: options.instanceId ?? `test-${generateShareId()}`,
      timings: { ...TEST_TIMINGS, ...options.timings },
      sweeperIntervalMs: 0,
    });
    await server.listen();
    this.servers.push(server);
    return server;
  }

  token(shareId: string, role: Role, clientId = generateClientId(), exp?: number): Promise<string> {
    const payload: CollabTokenPayload = {
      shareId,
      clientId,
      name: "Tester",
      color: "#336699",
      role,
      exp: exp ?? Math.floor(Date.now() / 1000) + 600,
    };
    return signCollabToken(payload, TEST_SECRET);
  }

  async connect(url: string, shareId: string, options: ConnectOptions = {}): Promise<Client> {
    const clientId = options.clientId ?? generateClientId();
    const token = options.token ?? (await this.token(shareId, options.role ?? "edit", clientId));
    const doc = new Y.Doc();
    const client: Partial<Client> = {
      doc,
      text: doc.getText("file:main"),
      clientId,
      stateless: [],
      closes: [],
      received: [],
    };
    let resolveSynced!: () => void;
    let resolveDenied!: (reason: string) => void;
    client.synced = new Promise((resolve) => {
      resolveSynced = resolve;
    });
    client.denied = new Promise((resolve) => {
      resolveDenied = resolve;
    });
    const socket = new HocuspocusProviderWebsocket({
      url: `${url}/collab?doc=${shareId}`,
      WebSocketPolyfill: WebSocket,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: shareId,
      document: doc,
      token,
      onSynced: () => resolveSynced(),
      onAuthenticationFailed: ({ reason }) => resolveDenied(reason),
      onStateless: ({ payload }) => client.stateless?.push(JSON.parse(payload)),
      onClose: ({ event }) => {
        if (event.reason) client.closes?.push(event.reason);
      },
      onMessage: ({ event }) => {
        const data = event.data as ArrayBuffer | Uint8Array;
        client.received?.push(data instanceof Uint8Array ? data : new Uint8Array(data));
      },
    });
    provider.attach();
    client.provider = provider;
    client.socket = socket;
    client.destroy = () => {
      provider.destroy();
      socket.destroy();
    };
    this.clients.push(client as Client);
    return client as Client;
  }

  publishPerm(shareId: string, message: PermMessage) {
    return this.redis.publish(channels.perm(shareId), JSON.stringify(message));
  }

  /**
   * Publishes on `cmd:<shareId>` like the API does and returns every reply: the first must arrive
   * within the §6.11 deadline, later ones are collected for `settleMs` more.
   */
  async command(
    shareId: string,
    message: CollabCommand | Record<string, unknown>,
    settleMs = 0,
  ): Promise<CollabCommandReply[]> {
    const requestId = typeof message.requestId === "string" ? message.requestId : "none";
    const subscriber = this.redis.duplicate();
    const replies: CollabCommandReply[] = [];
    try {
      await subscriber.subscribe(channels.cmdReply(requestId));
      subscriber.on("message", (_channel: string, raw: string) => {
        replies.push(collabCommandReplySchema.parse(JSON.parse(raw)));
      });
      await this.redis.publish(channels.cmd(shareId), JSON.stringify(message));
      await waitFor(() => replies.length > 0, `reply to ${requestId}`, COLLAB_COMMAND_TIMEOUT_MS);
      if (settleMs > 0) await sleep(settleMs);
      return replies;
    } finally {
      subscriber.disconnect();
    }
  }

  async close() {
    for (const client of this.clients) client.destroy();
    await Promise.all(this.servers.map((s) => s.destroy()));
    this.redis.disconnect();
    await this.database.drop();
  }
}

export interface StoreControl {
  /** Every call fails while true, like MongoDB being unreachable. */
  down: boolean;
  /** Calls per `store.method`, counted whether they fail or not. */
  calls: Record<string, number>;
  /** Runs before every call, e.g. to hold one until the test lets it go. */
  before?: (method: string, args: unknown[]) => Promise<void> | void;
}

/** `stores` with every method passing through `control` first. */
export function controlledStores(stores: Stores, control: StoreControl): Stores {
  const wrap = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== "function") return value;
        const method = `${name}.${String(property)}`;
        return async (...args: unknown[]) => {
          control.calls[method] = (control.calls[method] ?? 0) + 1;
          await control.before?.(method, args);
          if (control.down) throw new Error(`test: MongoDB is down (${method})`);
          return value.apply(object, args);
        };
      },
    });
  return Object.fromEntries(
    Object.entries(stores).map(([name, store]) => [name, wrap(name, store as object)]),
  ) as unknown as Stores;
}

/** A TCP proxy in front of Valkey whose connection can be cut, like a Valkey restart. */
export class ValkeyProxy {
  private readonly sockets = new Set<Socket>();
  private server: NetServer | null = null;
  private port = 0;

  private constructor(private readonly target: URL) {}

  static async start(): Promise<ValkeyProxy> {
    const proxy = new ValkeyProxy(new URL(VALKEY_TEST_URL));
    await proxy.up();
    return proxy;
  }

  get url(): string {
    const url = new URL(this.target);
    url.hostname = "127.0.0.1";
    url.port = String(this.port);
    return url.toString();
  }

  /** Starts accepting again, on the same port. */
  async up() {
    const server = createServer((client) => {
      const upstream = tcpConnect(Number(this.target.port || 6379), this.target.hostname);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    const address = server.address();
    if (address && typeof address === "object") this.port = address.port;
    this.server = server;
  }

  /** Cuts every connection and refuses new ones. */
  async down() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Text of a stored share: latest compact snapshot plus later updates, like a fresh load. */
export async function storedText(stores: Stores, shareId: string): Promise<string> {
  const loaded = await loadPersisted(stores, shareId);
  const doc = new Y.Doc();
  if (loaded.state) Y.applyUpdate(doc, loaded.state);
  return doc.getText("file:main").toString();
}
