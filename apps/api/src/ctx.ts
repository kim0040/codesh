import {
  apiKeys,
  COLLAB_COMMAND_TIMEOUT_MS,
  channels,
  type NearbyItem,
  type PermMessage,
  type PresenceUser,
  type Settings,
  type SseEvent,
} from "@gachipad/shared";
import { ServerDiagnostics, type Stores } from "@gachipad/storage";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { LdapAdapter, OidcAdapter } from "./auth/adapters.js";
import type { Config } from "./config.js";
import type { Hub } from "./hub.js";
import type { Metrics } from "./metrics.js";
import { type Cidr, parseCidrs } from "./net.js";
import { DEFAULT_UPDATE_TIMERS, UpdateChecker, type UpdateTimers } from "./updates.js";
import { VERSION } from "./version.js";

export interface Deps {
  diagnostics?: ServerDiagnostics;
  config: Config;
  stores: Stores;
  valkey: Redis;
  hub: Hub;
  metrics: Metrics;
  oidc?: OidcAdapter;
  ldap?: LdapAdapter;
  /** Join code generator, replaceable in tests to force collisions. */
  randomCode?: () => string;
  heartbeatMs?: number;
  presenceRefreshMs?: number;
  /** How long settings are cached per process; 0 in tests so a stored change applies at once. */
  settingsCacheMs?: number;
  /** How long the nearby list of a network group is shared by its open streams; 0 in tests. */
  nearbyCacheMs?: number;
  /** How long a content command waits for collab's reply (§6.11); shortened in tests. */
  commandTimeoutMs?: number;
  /** The running product version; the root package.json's unless a test pretends otherwise. */
  version?: string;
  /** Timing and transport of the update check, replaced in tests. */
  updateTimers?: UpdateTimers;
  updateFetch?: typeof fetch;
}

const SETTINGS_CACHE_MS = 5000;
const NEARBY_CACHE_MS = 5000;

/** Everything a route needs: stores, Valkey, settings and the event publishers. */
export class Ctx {
  unknownClientWarningAt = 0;
  readonly config: Config;
  readonly stores: Stores;
  readonly valkey: Redis;
  readonly hub: Hub;
  readonly metrics: Metrics;
  readonly oidc?: OidcAdapter;
  readonly ldap?: LdapAdapter;
  readonly randomCode?: () => string;
  readonly heartbeatMs?: number;
  readonly presenceRefreshMs?: number;
  readonly settingsCacheMs: number;
  readonly commandTimeoutMs: number;
  readonly nearbyCacheMs: number;
  /** In-flight or recent nearby lists per network group, see `listNearbyCached`. */
  readonly nearbyCache = new Map<string, { at: number; list: Promise<NearbyItem[]> }>();
  readonly trusted: Cidr[];
  readonly adminAllowed: Cidr[];
  readonly diagnostics: ServerDiagnostics;
  readonly startedAt = Date.now();
  readonly version: string;
  adminAuditAt = 0;
  adminAuditPending = false;
  /** Background check for a newer release (docs/OPERATIONS.md "업데이트"). */
  readonly updates: UpdateChecker;
  /** Open SSE streams in this process per client, so presence outlives a closed second tab. */
  readonly presenceCache = new Map<string, { at: number; list: Promise<PresenceUser[]> }>();
  readonly presencePublishes = new Map<string, Promise<void>>();
  readonly fallbackRates = new Map<string, { count: number; until: number }>();
  capacityAt = 0;
  capacityAvailable = true;
  readonly streams = new Map<string, number>();
  /** Ends every open SSE stream; called when the server closes. */
  readonly streamClosers = new Set<() => void>();
  private cached: { value: Settings; at: number } | null = null;

  constructor(deps: Deps) {
    this.config = deps.config;
    this.stores = deps.stores;
    this.valkey = deps.valkey;
    this.hub = deps.hub;
    this.metrics = deps.metrics;
    this.oidc = deps.oidc;
    this.ldap = deps.ldap;
    this.randomCode = deps.randomCode;
    this.heartbeatMs = deps.heartbeatMs;
    this.presenceRefreshMs = deps.presenceRefreshMs;
    this.settingsCacheMs = deps.settingsCacheMs ?? SETTINGS_CACHE_MS;
    this.commandTimeoutMs = deps.commandTimeoutMs ?? COLLAB_COMMAND_TIMEOUT_MS;
    this.nearbyCacheMs = deps.nearbyCacheMs ?? NEARBY_CACHE_MS;
    this.trusted = parseCidrs(deps.config.trustProxy);
    this.adminAllowed = parseCidrs(deps.config.adminAllowCidr);
    this.version = deps.version ?? VERSION;
    this.diagnostics =
      deps.diagnostics ??
      new ServerDiagnostics("api", deps.stores.diagnostics, process.env.INSTANCE_ID ?? "api");
    this.updates = new UpdateChecker(
      deps.config.update,
      deps.valkey,
      deps.version ?? VERSION,
      deps.updateTimers ?? DEFAULT_UPDATE_TIMERS,
      deps.updateFetch,
      () => this.diagnostics.record("update_error", {}, "warn"),
    );
  }

  async settings(): Promise<Settings> {
    if (this.cached && Date.now() - this.cached.at < this.settingsCacheMs) return this.cached.value;
    const value = await this.stores.settings.get();
    this.cached = { value, at: Date.now() };
    return value;
  }

  /** Last known settings for safe diagnostic presence flags while the database is unavailable. */
  settingsSnapshot(): Settings | null {
    return this.cached?.value ?? null;
  }

  invalidateSettings(): void {
    this.cached = null;
  }

  async publishUser(clientId: string, event: SseEvent): Promise<void> {
    await this.valkey.publish(channels.user(clientId), JSON.stringify(event));
  }

  async publishNet(net: string, event: SseEvent): Promise<void> {
    await this.valkey.publish(channels.net(net), JSON.stringify(event));
  }

  /** Permission change for collab (§6.7). No `clientId` means everyone connected to the share. */
  async publishPerm(shareId: string, kind: PermMessage["kind"], clientId?: string): Promise<void> {
    // One script, so two API instances can never publish their versions out of order.
    const message = JSON.stringify({ kind, ...(clientId ? { clientId } : {}) });
    await this.valkey
      .eval(
        PUBLISH_PERM,
        1,
        apiKeys.permVersion(shareId),
        channels.perm(shareId),
        message,
        30 * 24 * 3600,
      )
      .catch(async (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !/OOM|command not allowed when used memory/i.test(error.message)
        )
          throw error;
        // Permission messages must still arrive when INCR cannot allocate a counter. Mongo's
        // generation is the authority; kick/lock/delete and global role messages accept version 0.
        await this.valkey.publish(
          channels.perm(shareId),
          JSON.stringify({ version: 0, kind, ...(clientId ? { clientId } : {}) }),
        );
      });
  }

  /** Writes an audit entry when `settings.audit.enabled`. */
  async audit(
    request: FastifyRequest,
    action: string,
    shareId?: string,
    detail?: unknown,
  ): Promise<void> {
    const settings = await this.settings();
    if (!settings.audit.enabled) return;
    await this.stores.audit.append({
      at: new Date(),
      actor: request.session.clientId,
      ip: request.session.ip,
      action,
      ...(shareId ? { shareId } : {}),
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

/** INCRs the share's perm version and publishes the message with it in one step (§6.7). */
const PUBLISH_PERM = `
local version = redis.call("INCR", KEYS[1])
if version == 1 then redis.call("EXPIRE", KEYS[1], ARGV[3]) end
local message = cjson.decode(ARGV[2])
message.version = version
redis.call("PUBLISH", ARGV[1], cjson.encode(message))
return version
`;
