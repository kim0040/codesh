import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  apiKeys,
  MAX_RELEASE_NOTES,
  type UpdaterStatus,
  type UpdateState,
  updaterStatusSchema,
} from "@codesh/shared";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { UpdateConfig } from "./config.js";
import { compareSemver, formatSemver, parseSemver, type SemVer } from "./semver.js";

/**
 * The update check: the one outbound request codesh makes, and only while UPDATE_CHECK is on
 * (docs/ARCHITECTURE.md §14). A plain unauthenticated GET of the repository's latest release:
 * no identifiers, no cookies, nothing about the installation but `User-Agent: codesh/<version>`.
 * It runs in the background, a few minutes after start and then about every 12 hours, by one api
 * instance per deployment (Valkey lock); a failure only marks the state `unreachable`.
 */

export interface UpdateTimers {
  firstDelayMs: number;
  /** Extra random delay of the first check, so replicas started together do not line up. */
  firstJitterMs: number;
  intervalMs: number;
  /** Each later check is moved by up to this much either way. */
  jitterMs: number;
  timeoutMs: number;
}

export const DEFAULT_UPDATE_TIMERS: UpdateTimers = {
  firstDelayMs: 3 * 60_000,
  firstJitterMs: 2 * 60_000,
  intervalMs: 12 * 3600_000,
  jitterMs: 30 * 60_000,
  timeoutMs: 5000,
};

/** Bodies above this are not read; a release object is a few kilobytes. */
const MAX_BODY_BYTES = 1024 * 1024;
const LOCK_MS = 30_000;
const STATE_TTL_SECONDS = 30 * 24 * 3600;
/** Never wait longer than this for a rate limit that names a later reset. */
const MAX_BACKOFF_MS = 24 * 3600_000;

interface Logger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

/** What is kept in Valkey. `source` ties the cached release and ETag to repo and channel. */
interface Stored {
  source: string;
  latest: string | null;
  url: string | null;
  publishedAt: string | null;
  notes: string | null;
  checkedAt: string | null;
  status: "ok" | "unreachable";
  etag: string | null;
  /** Epoch ms before which GitHub asked not to be asked again (rate limit). */
  retryAt: number | null;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  published_at: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});
type Release = z.infer<typeof releaseSchema>;

/** Plain text for a `textContent` node: no control characters, capped. */
export function plainNotes(body: string | null | undefined): string | null {
  if (!body) return null;
  const text = body
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > MAX_RELEASE_NOTES ? `${text.slice(0, MAX_RELEASE_NOTES - 1)}…` : text;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("release response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class UpdateChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly source: string;
  private readonly current: SemVer | null;

  constructor(
    private readonly config: UpdateConfig,
    private readonly valkey: Redis,
    readonly version: string,
    private readonly timers: UpdateTimers = DEFAULT_UPDATE_TIMERS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onFailure: () => void = () => {},
  ) {
    this.source = `${config.repo}|${config.channel}`;
    this.current = parseSemver(version);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Schedules the background checks; does nothing while UPDATE_CHECK is off. */
  start(log?: Logger): void {
    if (!this.config.enabled || this.timer || this.stopped) return;
    const first = this.timers.firstDelayMs + Math.random() * this.timers.firstJitterMs;
    const tick = async () => {
      try {
        await this.check(false, log);
      } catch (error) {
        this.onFailure();
        // Valkey trouble: the next tick tries again.
        log?.warn({ err: error }, "update check failed");
      }
      if (this.stopped) return;
      const jitter = (Math.random() * 2 - 1) * this.timers.jitterMs;
      this.timer = setTimeout(tick, Math.max(60_000, this.timers.intervalMs + jitter));
      this.timer.unref();
    };
    this.timer = setTimeout(tick, first);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Asks GitHub unless another instance holds the lock or, for a scheduled check, checked within
   * the interval. Returns whether a request was made.
   */
  async check(manual: boolean, log?: Logger): Promise<boolean> {
    if (!this.config.enabled) return false;
    const token = randomBytes(8).toString("hex");
    if ((await this.valkey.set(apiKeys.updateLock, token, "PX", LOCK_MS, "NX")) !== "OK")
      return false;
    try {
      const stored = await this.load();
      const now = Date.now();
      if (stored?.retryAt && now < stored.retryAt) return false;
      const last = stored?.checkedAt ? Date.parse(stored.checkedAt) : 0;
      if (!manual && now - last < this.timers.intervalMs * 0.9) return false;
      const next = await this.ask(stored);
      if (next.status !== "ok") this.onFailure();
      await this.valkey.set(apiKeys.updateState, JSON.stringify(next), "EX", STATE_TTL_SECONDS);
      if (next.status === "ok" && next.latest !== stored?.latest)
        log?.info({ latest: next.latest, current: this.version }, "update check: latest release");
      return true;
    } finally {
      await this.valkey.eval(RELEASE_LOCK, 1, apiKeys.updateLock, token).catch(() => undefined);
    }
  }

  async state(): Promise<UpdateState> {
    const empty: UpdateState = {
      current: this.version,
      latest: null,
      url: null,
      publishedAt: null,
      notes: null,
      checkedAt: null,
      status: this.config.enabled ? "pending" : "disabled",
      updateAvailable: false,
    };
    if (!this.config.enabled) return empty;
    const stored = await this.load();
    if (!stored) return empty;
    const latest = stored.latest ? parseSemver(stored.latest) : null;
    return {
      ...empty,
      latest: stored.latest,
      url: stored.url,
      publishedAt: stored.publishedAt,
      notes: stored.notes,
      checkedAt: stored.checkedAt,
      status: stored.status,
      updateAvailable: Boolean(latest && this.current && compareSemver(latest, this.current) > 0),
    };
  }

  /** deploy/state/update.json, when update.sh wrote one and it is mounted. */
  async updaterStatus(): Promise<UpdaterStatus | null> {
    if (!this.config.statusFile) return null;
    try {
      const text = await readFile(this.config.statusFile, "utf8");
      if (text.length > 64 * 1024) return null;
      const parsed = updaterStatusSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async load(): Promise<Stored | null> {
    const raw = await this.valkey.get(apiKeys.updateState);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Stored;
      return stored.source === this.source ? stored : null;
    } catch {
      return null;
    }
  }

  private async ask(stored: Stored | null): Promise<Stored> {
    const { apiUrl, repo, channel } = this.config;
    const url =
      channel === "stable"
        ? `${apiUrl}/repos/${repo}/releases/latest`
        : `${apiUrl}/repos/${repo}/releases?per_page=20`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": `codesh/${this.version}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (stored?.etag) headers["If-None-Match"] = stored.etag;
    const checkedAt = new Date().toISOString();
    const keep: Stored = {
      source: this.source,
      latest: stored?.latest ?? null,
      url: stored?.url ?? null,
      publishedAt: stored?.publishedAt ?? null,
      notes: stored?.notes ?? null,
      checkedAt,
      status: "unreachable",
      etag: stored?.etag ?? null,
      retryAt: null,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(this.timers.timeoutMs),
      });
    } catch {
      return keep;
    }
    try {
      if (response.status === 304) return { ...keep, status: "ok" };
      // A repository without any release yet answers 404 to /releases/latest.
      if (response.status === 404) {
        await response.body?.cancel();
        return {
          ...keep,
          status: "ok",
          latest: null,
          url: null,
          publishedAt: null,
          notes: null,
          etag: null,
        };
      }
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        return { ...keep, retryAt: this.retryAt(response) };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return keep;
      }
      const data: unknown = JSON.parse(await readLimited(response));
      const release = this.pick(data);
      return {
        ...keep,
        status: "ok",
        etag: response.headers.get("etag"),
        latest: release ? release.version : null,
        url: release ? this.safeUrl(release.html_url) : null,
        publishedAt:
          release?.published_at && !Number.isNaN(Date.parse(release.published_at))
            ? new Date(release.published_at).toISOString()
            : null,
        notes: release ? plainNotes(release.body) : null,
      };
    } catch {
      return keep;
    }
  }

  /** The newest release the channel allows: no drafts, pre-releases only on `prerelease`. */
  private pick(data: unknown): (Release & { version: string }) | null {
    const list = Array.isArray(data) ? data : [data];
    let best: (Release & { version: string; semver: SemVer }) | null = null;
    for (const item of list) {
      const parsed = releaseSchema.safeParse(item);
      if (!parsed.success || parsed.data.draft) continue;
      const semver = parseSemver(parsed.data.tag_name);
      if (!semver) continue;
      const pre = parsed.data.prerelease === true || semver.pre.length > 0;
      if (pre && this.config.channel !== "prerelease") continue;
      if (!best || compareSemver(semver, best.semver) > 0)
        best = { ...parsed.data, semver, version: formatSemver(semver) };
    }
    return best;
  }

  /** Only web links; plain http only when the API itself is plain http (tests). */
  private safeUrl(value: string): string | null {
    try {
      const url = new URL(value);
      const allowed =
        new URL(this.config.apiUrl).protocol === "http:" ? ["https:", "http:"] : ["https:"];
      return allowed.includes(url.protocol) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  /** When GitHub's rate limit resets (`x-ratelimit-reset`, `retry-after`), at least a minute away. */
  private retryAt(response: Response): number {
    const now = Date.now();
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    let at = now + 3600_000;
    if (Number.isFinite(retryAfter) && retryAfter > 0) at = now + retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) at = reset * 1000;
    return Math.min(now + MAX_BACKOFF_MS, Math.max(now + 60_000, at));
  }
}

/** Deletes the lock only if this instance still holds it. */
const RELEASE_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;
