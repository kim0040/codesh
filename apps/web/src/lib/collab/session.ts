import type { CollabStateless, Role, UserRef } from "@codesh/shared";
import { HocuspocusProvider, type HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { ApiError, api } from "../api";
import { acquireSocket } from "./socket";

/**
 * Everything about one open share that is not React: the Y.Doc, its IndexedDB copy, the provider
 * on the shared socket, the token refresh and the reaction to server-side permission changes.
 */

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "disconnected";

export interface JoinCredentials {
  pin?: string;
  editKey?: string;
}

export interface SessionState {
  status: ConnectionStatus;
  /** The first sync with the server (or the local copy, when offline) is done. */
  synced: boolean;
  role: Role;
  /** Typing is blocked: view-only link, or the owner locked editing. */
  readOnly: boolean;
  locked: boolean;
  /** Incremented whenever the Y.Doc was replaced, so the editor rebinds. */
  generation: number;
  /** Local edits the server has not confirmed yet. */
  unsynced: number;
  /** Why the server will not let this client in (after the join succeeded once). */
  denied: "unauthorized" | "not_found" | "banned" | "pin_required" | "pending_approval" | null;
  /** The server closed this connection for good. */
  closed: "kicked" | "deleted" | null;
  /** The share hit the size limit; set until the next successful resync. */
  tooLarge: number | null;
  /** The local copy was loaded from IndexedDB before the server answered. */
  restored: boolean;
}

export interface SessionOptions {
  shareId: string;
  user: UserRef;
  role: Role;
  credentials: JoinCredentials;
  /** Called once when the connection came back and local offline edits are merged. */
  onMerged?: () => void;
  onRole?: (role: Role, readOnly: boolean) => void;
}

const IDB_PREFIX = "codesh:doc:";
const AWARENESS_MIN_GAP_MS = Math.ceil(1000 / 30);

export function parseStateless(payload: string): CollabStateless | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (
      value.type === "role" &&
      typeof value.role === "string" &&
      typeof value.readOnly === "boolean"
    ) {
      return { type: "role", role: value.role as Role, readOnly: value.readOnly };
    }
    if (
      value.type === "locked" &&
      typeof value.locked === "boolean" &&
      typeof value.readOnly === "boolean"
    ) {
      return { type: "locked", locked: value.locked, readOnly: value.readOnly };
    }
    if (value.type === "too_large" && typeof value.maxDocBytes === "number") {
      return { type: "too_large", maxDocBytes: value.maxDocBytes };
    }
  } catch {
    // Not one of ours.
  }
  return null;
}

export class DocSession {
  readonly shareId: string;
  readonly user: UserRef;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  private persistence: IndexeddbPersistence | null = null;
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly releaseSocket: () => void;
  private credentials: JoinCredentials;
  private lastJoinError: ApiError | null = null;
  private listeners = new Set<() => void>();
  private destroyed = false;
  private everConnected = false;
  private editedWhileAway = false;
  private lastLocalEditAt = 0;
  private state: SessionState;
  private readonly options: SessionOptions;
  private docListener: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private onlineListener = () => this.refreshStatus();
  private pendingAwareness: Record<string, unknown> = {};
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAwarenessAt = 0;

  constructor(options: SessionOptions) {
    this.options = options;
    this.shareId = options.shareId;
    this.user = options.user;
    this.credentials = options.credentials;
    const held = acquireSocket(options.shareId);
    this.socket = held.socket;
    this.releaseSocket = held.release;
    this.state = {
      status: "connecting",
      synced: false,
      role: options.role,
      readOnly: options.role === "view",
      locked: false,
      generation: 0,
      unsynced: 0,
      denied: null,
      closed: null,
      tooLarge: null,
      restored: false,
    };
    this.doc = new Y.Doc();
    this.provider = this.createProvider(this.doc);
    this.attachPersistence();
    window.addEventListener("online", this.onlineListener);
    window.addEventListener("offline", this.onlineListener);
  }

  get awareness(): Awareness {
    const awareness = this.provider.awareness;
    if (!awareness) throw new Error("awareness is disabled");
    return awareness;
  }

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private patch(next: Partial<SessionState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private createProvider(doc: Y.Doc): HocuspocusProvider {
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: this.shareId,
      document: doc,
      token: () => this.fetchToken(),
      // Typing is batched on the wire for ~30 fps awareness, not for document updates.
      onStatus: () => this.refreshStatus(),
      onConnect: () => this.refreshStatus(),
      onDisconnect: () => {
        if (this.everConnected) this.patch({ synced: false });
        this.refreshStatus();
      },
      onAuthenticated: ({ scope }) => {
        this.everConnected = true;
        this.patch({ denied: null });
        if (scope === "readonly" && !this.state.readOnly) this.patch({ readOnly: true });
        // The provider sets `isAuthenticated` after this callback returns.
        queueMicrotask(() => this.refreshStatus());
      },
      onAuthenticationFailed: ({ reason }) => this.handleDenied(reason),
      onSynced: ({ state }) => {
        if (!state) return;
        this.patch({ synced: true });
        this.refreshStatus();
        if (this.editedWhileAway) {
          this.editedWhileAway = false;
          this.options.onMerged?.();
        }
      },
      onUnsyncedChanges: ({ number }) => this.patch({ unsynced: number }),
      onClose: ({ event }) => {
        const reason = event.reason;
        if (reason === "provider_initiated" && !this.destroyed && provider === this.provider) {
          // The server answering a Close sent by an earlier provider of this same document
          // (a React remount, a resync). It names the document, so it reaches this provider
          // too: join again over the open socket.
          void provider.onOpen(new Event("open"));
          return;
        }
        if (reason === "kicked" || reason === "deleted") {
          this.patch({ closed: reason });
          // Leave the document, but keep the shared socket for other documents of this tab.
          provider.detach();
        }
        this.refreshStatus();
      },
      onStateless: ({ payload }) => this.handleStateless(payload),
    });
    provider.attach();
    this.setLocalUser(provider);
    this.watchLocalEdits(doc);
    return provider;
  }

  private setLocalUser(provider: HocuspocusProvider) {
    provider.awareness?.setLocalStateField("user", {
      clientId: this.user.clientId,
      name: this.user.name,
      color: this.user.color,
    });
  }

  private watchLocalEdits(doc: Y.Doc) {
    if (this.docListener) return;
    this.docListener = (_update, origin) => {
      if (origin === this.provider || origin instanceof IndexeddbPersistence) return;
      this.lastLocalEditAt = Date.now();
      if (this.state.status !== "connected") this.editedWhileAway = true;
    };
    doc.on("update", this.docListener);
  }

  private attachPersistence() {
    // A per-document offline copy: edits survive a closed tab and merge on the next connect.
    try {
      this.persistence = new IndexeddbPersistence(`${IDB_PREFIX}${this.shareId}`, this.doc);
      this.persistence.whenSynced
        .then(() => {
          if (this.destroyed) return;
          if (this.doc.getMap("files").size > 0) this.patch({ restored: true });
        })
        .catch(() => undefined);
    } catch {
      this.persistence = null;
    }
  }

  /** Fresh collab token on every (re)connect; a failure becomes a rejected token, not a hang. */
  private async fetchToken(): Promise<string> {
    try {
      const result = await api.joinShare(this.shareId, this.credentials);
      if (!("token" in result)) {
        this.lastJoinError = new ApiError(202, "pending_approval", "pending", null);
        return "";
      }
      this.lastJoinError = null;
      if (result.role !== this.state.role) {
        this.patch({ role: result.role, readOnly: result.role === "view" || this.state.locked });
        this.options.onRole?.(result.role, this.state.readOnly);
      }
      return result.token;
    } catch (error) {
      this.lastJoinError = error instanceof ApiError ? error : null;
      return "";
    }
  }

  private handleDenied(reason: string) {
    const failure = this.lastJoinError;
    let denied: SessionState["denied"] = "unauthorized";
    if (failure?.code === "pin_required" || failure?.code === "pin_invalid")
      denied = "pin_required";
    else if (failure?.code === "pending_approval") denied = "pending_approval";
    else if (failure?.code === "banned" || reason === "banned") denied = "banned";
    else if (
      failure?.code === "not_found" ||
      failure?.code === "expired" ||
      reason === "not_found"
    ) {
      denied = "not_found";
    }
    this.patch({ denied });
  }

  private handleStateless(payload: string) {
    const message = parseStateless(payload);
    if (!message) return;
    if (message.type === "too_large") {
      this.patch({ tooLarge: message.maxDocBytes, readOnly: this.state.readOnly });
      void this.resync();
      return;
    }
    const wasReadOnly = this.state.readOnly;
    if (message.type === "role") {
      this.patch({ role: message.role, readOnly: message.readOnly });
      this.options.onRole?.(message.role, message.readOnly);
    } else {
      this.patch({ locked: message.locked, readOnly: message.readOnly });
      this.options.onRole?.(this.state.role, message.readOnly);
    }
    // Edits typed in the instant before the server flipped to read-only were refused and would
    // keep poisoning this client's later updates (packages/shared/src/collab.ts).
    const recentlyEdited = Date.now() - this.lastLocalEditAt < 4000;
    if (message.readOnly && !wasReadOnly && (recentlyEdited || this.state.unsynced > 0)) {
      void this.resync();
    }
  }

  private refreshStatus() {
    if (this.destroyed) return;
    const connected = this.socket.status === "connected" && this.provider.isAuthenticated;
    let status: ConnectionStatus;
    if (typeof navigator !== "undefined" && navigator.onLine === false) status = "offline";
    else if (connected) status = "connected";
    else if (this.socket.status === "connecting") {
      status = this.everConnected ? "reconnecting" : "connecting";
    } else status = this.everConnected ? "disconnected" : "connecting";
    if (status !== this.state.status) this.patch({ status });
  }

  /** Re-checks the connection state once (the socket does not emit on every change). */
  poll(): void {
    this.refreshStatus();
  }

  /** The PIN or edit key changed in the UI (gate passed): connect again with it. */
  async reconnect(credentials?: JoinCredentials): Promise<void> {
    if (credentials) this.credentials = credentials;
    this.patch({ denied: null });
    await this.provider.connect().catch(() => undefined);
  }

  /** Drop the Y.Doc, its local copy and the provider, then start over from the server state. */
  async resync(): Promise<void> {
    if (this.destroyed) return;
    const old = this.provider;
    const oldDoc = this.doc;
    const oldPersistence = this.persistence;
    if (this.docListener) oldDoc.off("update", this.docListener);
    this.docListener = null;
    this.pendingAwareness = {};
    old.destroy();
    this.persistence = null;
    try {
      await oldPersistence?.clearData();
    } catch {
      // The copy may already be gone.
    }
    oldPersistence?.destroy().catch(() => undefined);
    oldDoc.destroy();
    this.doc = new Y.Doc();
    this.editedWhileAway = false;
    this.provider = this.createProvider(this.doc);
    this.attachPersistence();
    this.patch({
      generation: this.state.generation + 1,
      synced: false,
      unsynced: 0,
      restored: false,
    });
    this.refreshStatus();
  }

  /**
   * Merges fields into this client's awareness state, at most ~30 times a second
   * (docs/ARCHITECTURE.md §4). The latest value of each field always wins.
   */
  publish(patch: Record<string, unknown>): void {
    this.pendingAwareness = { ...this.pendingAwareness, ...patch };
    if (this.awarenessTimer || this.destroyed) return;
    const wait = Math.max(0, AWARENESS_MIN_GAP_MS - (Date.now() - this.lastAwarenessAt));
    this.awarenessTimer = setTimeout(() => this.flushAwareness(), wait);
  }

  private flushAwareness() {
    this.awarenessTimer = null;
    const awareness = this.provider.awareness;
    const patch = this.pendingAwareness;
    this.pendingAwareness = {};
    if (!awareness || this.destroyed) return;
    this.lastAwarenessAt = Date.now();
    awareness.setLocalState({ ...(awareness.getLocalState() ?? {}), ...patch });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener("online", this.onlineListener);
    window.removeEventListener("offline", this.onlineListener);
    if (this.docListener) this.doc.off("update", this.docListener);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.provider.destroy();
    this.persistence?.destroy().catch(() => undefined);
    this.releaseSocket();
    this.listeners.clear();
  }
}
