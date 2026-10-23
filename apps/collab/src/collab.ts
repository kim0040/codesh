import {
  COLLAB_CLOSE_REASONS,
  COLLAB_DENY_REASONS,
  COMPACT_AFTER_UPDATES,
  type CollabStateless,
  DEFAULT_FILE_ID,
  defaultSettings,
  FLUSH_INTERVAL_MS,
  HISTORY_SNAPSHOT_INTERVAL_MS,
  keys,
  LAST_ACTIVE_WRITE_INTERVAL_MS,
  NEARBY_ITEM_TTL_SECONDS,
  NEARBY_PREVIEW_LINES,
  NEARBY_THROTTLE_MS,
  type PermMessage,
  permMessageSchema,
  type Role,
  type Settings,
  type ShareRecord,
  SLOW_CLIENT_BUFFER_BYTES,
  UNLOAD_DELAY_MS,
  verifyCollabToken,
  YDOC,
} from "@codesh/shared";
import type { Stores } from "@codesh/storage";
import type {
  afterHandleMessagePayload,
  afterUnloadDocumentPayload,
  beforeSyncPayload,
  beforeUnloadDocumentPayload,
  Connection,
  connectedPayload,
  Document,
  Extension,
  Hocuspocus,
  onAuthenticatePayload,
  onChangePayload,
  onConfigurePayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
} from "@hocuspocus/server";
import type { Redis } from "ioredis";
import * as Y from "yjs";
import { ValkeyLock } from "./lock.js";
import type { CollabMetrics } from "./metrics.js";
import { PersistedDoc } from "./persisted-doc.js";
import { guardSlowClient } from "./slow-client.js";

export interface CollabContext {
  clientId: string;
  name: string;
  color: string;
  role: Role;
  shareId: string;
}

export interface CollabTimings {
  flushIntervalMs: number;
  compactAfter: number;
  historyIntervalMs: number;
  unloadDelayMs: number;
  lockTtlMs: number;
  lockRenewMs: number;
  nearbyThrottleMs: number;
  nearbyRefreshMs: number;
  lastActiveIntervalMs: number;
  settingsRefreshMs: number;
  slowClientBytes: number;
}

export const DEFAULT_TIMINGS: CollabTimings = {
  flushIntervalMs: FLUSH_INTERVAL_MS,
  compactAfter: COMPACT_AFTER_UPDATES,
  historyIntervalMs: HISTORY_SNAPSHOT_INTERVAL_MS,
  unloadDelayMs: UNLOAD_DELAY_MS,
  lockTtlMs: 6000,
  lockRenewMs: 2000,
  nearbyThrottleMs: NEARBY_THROTTLE_MS,
  nearbyRefreshMs: (NEARBY_ITEM_TTL_SECONDS * 1000) / 2,
  lastActiveIntervalMs: LAST_ACTIVE_WRITE_INTERVAL_MS,
  settingsRefreshMs: 30_000,
  slowClientBytes: SLOW_CLIENT_BUFFER_BYTES,
};

export interface CollabDeps {
  stores: Stores;
  /** Commands (locks, nearby). */
  redis: Redis;
  /** A dedicated connection for `perm:*` (a subscribed connection cannot run commands). */
  subscriber: Redis;
  secret: string;
  instanceId: string;
  metrics: CollabMetrics;
  timings?: Partial<CollabTimings>;
}

/** Viewers, and everyone but the owner of a locked share, cannot edit (§6.7). */
export function isReadOnly(role: Role, locked: boolean): boolean {
  return role === "view" || (locked && role !== "owner");
}

class DocState {
  locked: boolean;
  nearby: boolean;
  share: ShareRecord;
  idleSince: number | null = Date.now();
  unloadTimer: NodeJS.Timeout | null = null;
  nearbyTimer: NodeJS.Timeout | null = null;
  nearbyAt = 0;
  lastActiveWrite = 0;
  permVersion = -1;
  deleted = false;
  flushing = false;
  readonly closed: Promise<void>;
  markClosed!: () => void;

  constructor(
    readonly name: string,
    readonly document: Document,
    readonly core: PersistedDoc,
    share: ShareRecord,
  ) {
    this.share = share;
    this.locked = share.locked;
    this.nearby = share.access.nearby;
    this.closed = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  clearTimers() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (this.nearbyTimer) clearTimeout(this.nearbyTimer);
    this.unloadTimer = null;
    this.nearbyTimer = null;
  }
}

/** A refusal in the shape Hocuspocus forwards to the provider as `onAuthenticationFailed`. */
function deny(reason: string) {
  return Object.assign(new Error(reason), { reason });
}

function context(connection: Connection): CollabContext {
  return connection.context as CollabContext;
}

function originLabel(origin: unknown): string {
  if (typeof origin === "object" && origin !== null && "source" in origin) {
    return String(origin.source);
  }
  return "local";
}

/** True when a Yjs update only deletes; deletions never grow a document. */
function onlyDeletes(update: Uint8Array): boolean {
  try {
    return Y.decodeUpdate(update).structs.length === 0;
  } catch {
    return false;
  }
}

/**
 * The collaboration extension: token auth, permission enforcement, batched persistence with a doc
 * lock, delayed unload, live permission changes, size limit, nearby previews and activity (§6).
 */
export class Collab implements Extension<CollabContext> {
  extensionName = "codesh-collab";
  /** Before extension-redis (1000), so a postponed unload does not wait for its disconnect delay. */
  priority = 1100;

  readonly timings: CollabTimings;
  readonly docs = new Map<string, DocState>();
  private instance!: Hocuspocus;
  private readonly lock: ValkeyLock;
  private settings: Settings = defaultSettings();
  private settingsAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private readonly refused = new WeakSet<Connection>();
  private shuttingDown = false;
  private lockTicking = false;

  constructor(private readonly deps: CollabDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.lock = new ValkeyLock(deps.redis, deps.instanceId, this.timings.lockTtlMs);
  }

  // lifecycle

  async onConfigure({ instance }: onConfigurePayload) {
    this.instance = instance;
  }

  /** Starts the flush and lock timers and the permission subscription. */
  async start() {
    await this.refreshSettings(true);
    this.deps.subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
      void this.applyPermission(channel.slice("perm:".length), message);
    });
    await this.deps.subscriber.psubscribe("perm:*");
    this.timers.push(
      setInterval(() => this.flushTick(), this.timings.flushIntervalMs),
      setInterval(() => void this.lockTick(), this.timings.lockRenewMs),
    );
  }

  /**
   * SIGTERM path (§6.6): from now on documents unload without delay. Documents nobody is connected
   * to are unloaded here; Hocuspocus unloads the others when `destroy()` closes their connections.
   */
  beginShutdown() {
    this.shuttingDown = true;
    for (const state of this.docs.values()) {
      state.clearTimers();
      if (state.document.getConnectionsCount() === 0)
        void this.instance.unloadDocument(state.document);
    }
  }

  async onDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.deps.subscriber.punsubscribe("perm:*").catch(() => {});
  }

  // auth

  async onAuthenticate({ token, documentName, connectionConfig }: onAuthenticatePayload) {
    const payload = await verifyCollabToken(token, this.deps.secret);
    if (!payload || payload.shareId !== documentName) throw deny(COLLAB_DENY_REASONS.unauthorized);
    const share = await this.deps.stores.shares.get(documentName);
    if (!share) throw deny(COLLAB_DENY_REASONS.notFound);
    if (share.bans.includes(payload.clientId)) throw deny(COLLAB_DENY_REASONS.banned);
    connectionConfig.readOnly = isReadOnly(payload.role, share.locked);
    const result: CollabContext = {
      clientId: payload.clientId,
      name: payload.name,
      color: payload.color,
      role: payload.role,
      shareId: payload.shareId,
    };
    return result;
  }

  // load and unload

  async onLoadDocument({ document, documentName }: onLoadDocumentPayload) {
    const previous = this.docs.get(documentName);
    if (previous && previous.document !== document) {
      // A fast reconnect can load the doc again while the previous copy is still saving. A copy
      // that was never destroyed is left over from a load that failed after this hook.
      if (previous.document.isDestroyed) await previous.closed;
      else await this.release(previous);
    }

    const share = await this.deps.stores.shares.get(documentName);
    if (!share) throw deny(COLLAB_DENY_REASONS.notFound);
    const core = new PersistedDoc(documentName, document, this.deps.stores, {
      compactAfter: this.timings.compactAfter,
      historyIntervalMs: this.timings.historyIntervalMs,
      onFlush: (ms) => this.deps.metrics.flushSeconds.observe(ms / 1000),
    });
    const lockKey = keys.docLock(documentName);
    core.owner = await this.lock.acquire(lockKey).catch(() => false);
    try {
      await core.load();
    } catch (error) {
      if (core.owner) await this.lock.release(lockKey).catch(() => {});
      throw error;
    }
    this.docs.set(documentName, new DocState(documentName, document, core, share));
  }

  async connected({ connection, documentName }: connectedPayload<CollabContext>) {
    const state = this.docs.get(documentName);
    if (state) {
      state.idleSince = null;
      if (state.unloadTimer) clearTimeout(state.unloadTimer);
      state.unloadTimer = null;
    }
    guardSlowClient(connection.webSocket, this.timings.slowClientBytes, () =>
      this.deps.metrics.slowClients.inc(),
    );
  }

  async onDisconnect({ document, documentName }: onDisconnectPayload) {
    const state = this.docs.get(documentName);
    if (state?.document === document && document.getConnectionsCount() === 0) {
      state.idleSince = Date.now();
    }
  }

  async beforeUnloadDocument({ document, documentName }: beforeUnloadDocumentPayload) {
    const state = this.docs.get(documentName);
    if (!state || state.document !== document) return;
    if (!this.shuttingDown && !state.deleted) {
      // §6.5: keep the doc warm for 30 s after the last connection leaves.
      const idleFor = Date.now() - (state.idleSince ?? Date.now());
      const remaining = this.timings.unloadDelayMs - idleFor;
      if (remaining > 0) {
        this.scheduleUnload(state, remaining);
        return Promise.reject();
      }
    }
    if (state.deleted) return;
    try {
      await state.core.history(true);
      await state.core.compact();
    } catch (error) {
      // Keep the doc in memory rather than lose updates; try again later.
      console.error(`collab: saving ${documentName} before unload failed`, error);
      if (!this.shuttingDown) this.scheduleUnload(state, this.timings.unloadDelayMs);
      return Promise.reject();
    }
  }

  async afterUnloadDocument({ documentName }: afterUnloadDocumentPayload) {
    const state = this.docs.get(documentName);
    if (!state?.document.isDestroyed) return;
    state.clearTimers();
    try {
      // Updates that arrived from other instances while extension-redis delayed the unload.
      if (!state.deleted) await state.core.flush();
    } catch (error) {
      console.error(`collab: final flush of ${documentName} failed`, error);
    }
    await this.release(state);
  }

  /** Forgets a doc: stops recording, gives up the lock and its nearby entry. */
  private async release(state: DocState) {
    state.clearTimers();
    state.core.detach();
    if (state.core.owner) {
      state.core.disown();
      await this.lock.release(keys.docLock(state.name)).catch(() => {});
      await this.deps.redis.del(keys.nearbyItem(state.name)).catch(() => {});
    }
    if (this.docs.get(state.name) === state) this.docs.delete(state.name);
    state.markClosed();
  }

  private scheduleUnload(state: DocState, delayMs: number) {
    if (state.unloadTimer) clearTimeout(state.unloadTimer);
    state.unloadTimer = setTimeout(() => {
      state.unloadTimer = null;
      void this.instance.unloadDocument(state.document);
    }, delayMs);
  }

  // keystroke path: no awaits on MongoDB

  async onChange({ documentName, document, transactionOrigin }: onChangePayload) {
    this.deps.metrics.updates.inc({ origin: originLabel(transactionOrigin) });
    const state = this.docs.get(documentName);
    if (!state || state.document !== document || state.deleted) return;
    const now = Date.now();
    if (state.core.owner && now - state.lastActiveWrite >= this.timings.lastActiveIntervalMs) {
      state.lastActiveWrite = now;
      void this.touch(state, now);
    }
    if (!state.nearbyTimer) {
      const wait = Math.max(0, state.nearbyAt + this.timings.nearbyThrottleMs - now);
      state.nearbyTimer = setTimeout(() => {
        state.nearbyTimer = null;
        void this.publishNearby(state);
      }, wait);
    }
  }

  /** §6.6 size limit: refuse an update that would grow the doc past `settings.maxDocBytes`. */
  async beforeSync({ connection, document, type, payload }: beforeSyncPayload<CollabContext>) {
    // y-protocols: 1 = SyncStep2, 2 = Update; SyncStep1 carries no content.
    if ((type !== 1 && type !== 2) || connection.readOnly) return;
    const state = this.docs.get(document.name);
    if (!state) return;
    const max = this.settings.maxDocBytes;
    if (state.core.sizeEstimate + payload.byteLength <= max) return;
    if (onlyDeletes(payload)) return;
    if (state.core.measure() + payload.byteLength <= max) return;
    // Hocuspocus answers a read-only connection's update with "not applied"; restored right after.
    this.refused.add(connection);
    connection.readOnly = true;
    this.deps.metrics.refusedTooLarge.inc();
    this.notify(connection, { type: "too_large", maxDocBytes: max });
  }

  async afterHandleMessage({ connection, document }: afterHandleMessagePayload<CollabContext>) {
    if (!this.refused.has(connection)) return;
    this.refused.delete(connection);
    const state = this.docs.get(document.name);
    connection.readOnly = isReadOnly(context(connection).role, state?.locked ?? false);
  }

  // timers

  private flushTick() {
    for (const state of this.docs.values()) {
      const { core } = state;
      if (state.flushing || state.deleted || !core.owner) continue;
      if (core.pendingUpdates === 0 && !core.needsCompaction && !core.historyDue) continue;
      state.flushing = true;
      const work = async () => {
        await core.flush();
        if (core.needsCompaction) await core.compact();
        if (core.historyDue) await core.history();
      };
      work()
        .catch((error) => {
          this.deps.metrics.flushErrors.inc();
          console.error(`collab: flush of ${state.name} failed, retrying`, error);
        })
        .finally(() => {
          state.flushing = false;
        });
    }
  }

  private async lockTick() {
    if (this.lockTicking) return;
    this.lockTicking = true;
    try {
      await this.lockUpkeep();
    } finally {
      this.lockTicking = false;
    }
  }

  private async lockUpkeep() {
    await this.refreshSettings();
    const now = Date.now();
    for (const state of [...this.docs.values()]) {
      if (state.deleted || state.document.isDestroyed) continue;
      const key = keys.docLock(state.name);
      try {
        if (state.core.owner) {
          if (!(await this.lock.renew(key))) state.core.disown();
        } else if (await this.lock.acquire(key)) {
          await state.core.adopt();
        }
      } catch (error) {
        // Valkey or MongoDB unavailable: keep the current role and retry on the next tick.
        console.error(`collab: lock upkeep of ${state.name} failed`, error);
      }
      if (state.core.owner && state.document.getConnectionsCount() > 0) {
        if (now - state.nearbyAt >= this.timings.nearbyRefreshMs)
          void this.publishNearby(state, true);
      }
    }
  }

  private async refreshSettings(force = false) {
    if (!force && Date.now() - this.settingsAt < this.timings.settingsRefreshMs) return;
    this.settingsAt = Date.now();
    try {
      this.settings = await this.deps.stores.settings.get();
    } catch (error) {
      console.error("collab: reading settings failed", error);
    }
  }

  /** §6.10 and §5 expiry: at most once per minute per doc, from the lock owner only. */
  private async touch(state: DocState, now: number) {
    const expiresAt = new Date(now + this.settings.anonymousTtlHours * 3600_000);
    try {
      await this.deps.stores.shares.touch(
        state.name,
        new Date(now),
        expiresAt,
        state.core.sizeEstimate,
      );
    } catch (error) {
      console.error(`collab: activity write for ${state.name} failed`, error);
    }
  }

  /** §6.9: `nearby:item:<id>` while the share is listed nearby; refreshes the share record first. */
  private async publishNearby(state: DocState, refreshShare = false) {
    if (!state.core.owner || state.deleted) return;
    state.nearbyAt = Date.now();
    try {
      if (refreshShare) {
        const share = await this.deps.stores.shares.get(state.name);
        if (share) {
          state.share = share;
          state.nearby = share.access.nearby;
        }
      }
      const key = keys.nearbyItem(state.name);
      if (!state.nearby) {
        await this.deps.redis.del(key);
        return;
      }
      const meta = state.document.getMap(YDOC.meta);
      const text = state.document.getText(YDOC.fileText(DEFAULT_FILE_ID)).toString();
      const preview = text.split("\n", NEARBY_PREVIEW_LINES).join("\n");
      const title = meta.get("title");
      const language = meta.get("language");
      await this.deps.redis
        .multi()
        .hset(key, {
          id: state.name,
          title: typeof title === "string" ? title : state.share.title,
          language: typeof language === "string" ? language : state.share.language,
          participants: String(state.document.awareness.getStates().size),
          preview,
        })
        .expire(key, NEARBY_ITEM_TTL_SECONDS)
        .exec();
    } catch (error) {
      console.error(`collab: nearby publish for ${state.name} failed`, error);
    }
  }

  // permissions (§6.7)

  async applyPermission(shareId: string, raw: string) {
    let message: PermMessage;
    try {
      message = permMessageSchema.parse(JSON.parse(raw));
    } catch {
      console.error(`collab: ignoring malformed perm message for ${shareId}`);
      return;
    }
    const state = this.docs.get(shareId);
    if (!state || state.document.isDestroyed) return;
    if (message.version < state.permVersion) return;
    state.permVersion = message.version;

    const connections = state.document.getConnections();
    const targets = (c: Connection) =>
      message.clientId === undefined || context(c).clientId === message.clientId;

    switch (message.kind) {
      case "kick":
        if (message.clientId === undefined) return;
        for (const c of connections.filter(targets)) {
          c.close({ code: 4403, reason: COLLAB_CLOSE_REASONS.kicked });
        }
        return;
      case "role": {
        const { role, clientId } = message;
        if (role !== undefined && clientId !== undefined) {
          for (const c of connections.filter(targets)) {
            context(c).role = role;
            c.readOnly = isReadOnly(role, state.locked);
            this.notify(c, { type: "role", role, readOnly: c.readOnly });
          }
          return;
        }
        for (const c of connections.filter(targets)) {
          if (context(c).role !== "owner")
            c.close({ code: 4401, reason: COLLAB_CLOSE_REASONS.reauth });
        }
        return;
      }
      case "lock": {
        const share = await this.deps.stores.shares.get(shareId);
        if (!share) return this.applyDelete(state);
        state.share = share;
        state.locked = share.locked;
        for (const c of state.document.getConnections()) {
          c.readOnly = isReadOnly(context(c).role, state.locked);
          this.notify(c, { type: "locked", locked: state.locked, readOnly: c.readOnly });
        }
        return;
      }
      case "delete":
        return this.applyDelete(state);
    }
  }

  private applyDelete(state: DocState) {
    state.deleted = true;
    if (state.core.owner) {
      state.core.disown();
      void this.lock.release(keys.docLock(state.name)).catch(() => {});
      void this.deps.redis.del(keys.nearbyItem(state.name)).catch(() => {});
    }
    state.clearTimers();
    for (const c of state.document.getConnections()) {
      c.close({ code: 4404, reason: COLLAB_CLOSE_REASONS.deleted });
    }
    void this.instance.unloadDocument(state.document);
  }

  private notify(connection: Connection, message: CollabStateless) {
    connection.sendStateless(JSON.stringify(message));
  }

  /** Test and shutdown helper: writes every buffer now. */
  async flushAll() {
    await Promise.all([...this.docs.values()].map((s) => (s.deleted ? undefined : s.core.flush())));
  }
}
