/**
 * Diagnostics format 1: header, exportedAt, environment/config and deduplicated events.
 * Events contain only allowlisted operational fields. No request/response bodies, arbitrary
 * error text, document/file names, credentials or addresses are accepted. Stack frames keep
 * application source locations, without URL origins, query strings or fragments.
 */
export const DIAGNOSTIC_CAPS = { events: 500, bytes: 256 * 1024, days: 14 } as const;
export const DIAGNOSTIC_KINDS = [
  "uncaught",
  "rejection",
  "render",
  "api_failure",
  "connect",
  "disconnect",
  "reconnect",
  "offline",
  "first_sync",
  "slow_sync",
  "sync_error",
  "permission_error",
  "long_task",
  "server_error",
  "response_5xx",
  "mongo_error",
  "mongo_recovered",
  "valkey_error",
  "valkey_recovered",
  "flush_error",
  "flush_backoff",
  "slow_flush",
  "lock_lost",
  "update_error",
  "rate_limit",
  "admin_login_failed",
  "background_error",
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
export type DiagnosticSource = "client" | "api" | "collab";
export type DiagnosticLevel = "warn" | "error";
export interface DiagnosticEvent {
  kind: DiagnosticKind;
  source: DiagnosticSource;
  level: DiagnosticLevel;
  firstAt: string;
  lastAt: string;
  count: number;
  details: DiagnosticDetails;
}
export interface DiagnosticBreadcrumb {
  kind: DiagnosticKind;
  at: string;
  status?: number;
  code?: string | number;
}
export type DiagnosticSizeBucket = "lt_64k" | "64k_1m" | "1m_10m" | "gte_10m";
export type DiagnosticCountBucket = "0" | "1" | "2_5" | "6_20" | "gte_21";
export interface DiagnosticDetails {
  /** Random session reference; exports rehash it with a fresh salt. Never a share id. */
  shareRef?: string;
  route?: string;
  method?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  worstMs?: number;
  reconnects?: number;
  offlineMs?: number;
  closeCode?: number;
  reason?: string;
  message?: string;
  stack?: string;
  location?: string;
  line?: number;
  column?: number;
  backoffMs?: number;
  errorCode?: number;
  documentSize?: DiagnosticSizeBucket;
  fileCount?: DiagnosticCountBucket;
  connectionCount?: DiagnosticCountBucket;
}

export const diagnosticSizeBucket = (bytes: number): DiagnosticSizeBucket =>
  bytes < 64 * 1024
    ? "lt_64k"
    : bytes < 1024 * 1024
      ? "64k_1m"
      : bytes < 10 * 1024 * 1024
        ? "1m_10m"
        : "gte_10m";
export const diagnosticCountBucket = (count: number): DiagnosticCountBucket =>
  count <= 0 ? "0" : count === 1 ? "1" : count <= 5 ? "2_5" : count <= 20 ? "6_20" : "gte_21";

const ROUTE_WORDS = new Set(
  (
    "api session auth logout providers oidc ldap callback shares join save fork labels kick pending " +
    "history restore download files uploads codes presence nearby invites labs distribute settings " +
    "public version templates admin audit stats update check overview diagnostics export security lock expire delete"
  ).split(" "),
);
/** Only known route words survive; even a short join code or unusual id becomes :id. */
export function diagnosticRoute(raw: string): string {
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//")) return ":route";
  const parts = path.split("/").slice(0, 12);
  const idAfter = new Set(["shares", "labs", "uploads", "codes", "pending", "history", "files"]);
  const normalized: string[] = [];
  for (const part of parts)
    normalized.push(
      part === ""
        ? ""
        : idAfter.has(normalized.at(-1) ?? "")
          ? ":id"
          : ROUTE_WORDS.has(part)
            ? part
            : ":id",
    );
  return normalized.join("/").slice(0, 200);
}

export function diagnosticLocation(raw: string): string {
  const clean = raw.split(/[?#]/, 1)[0] ?? "";
  // No function names: a thrown error or eval frame may embed document/user text there.
  const match = clean.match(
    /(?:\/(?:assets\/[\w.-]+\.js|src\/[\w/.-]+\.[jt]sx?|node_modules\/[\w@/.-]+\.[cm]?js)|node:[\w/]+)(?::\d+(?::\d+)?)?$/,
  );
  return match?.[0]?.slice(-200) ?? "[source omitted]";
}

const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  "QuotaExceededError",
  "NotAllowedError",
  "NotFoundError",
  "NotSupportedError",
  "InvalidStateError",
  "SecurityError",
  "DataCloneError",
  "UnknownError",
  "VersionError",
  "TransactionInactiveError",
  "MongoServerError",
  "MongoNetworkError",
  "MongoServerSelectionError",
  "ReplyError",
]);
const ERRNO_CODES = new Set(
  "ECONNREFUSED ETIMEDOUT ECONNRESET ENOTFOUND EAI_AGAIN EPIPE".split(" "),
);

/** A name in code (`a`, `view.state`, `this.x`), never free text: no spaces, quotes or symbols. */
const IDENT = String.raw`[A-Za-z_$][\w$]{0,40}(?:\.[A-Za-z_$#][\w$]{0,40}){0,3}`;
const PROP = "<prop>";
/**
 * Engine messages (V8, SpiderMonkey, JavaScriptCore) and a few fixed library messages, whose only
 * variable parts are names from the code. Anything else becomes "(text omitted)": a message can
 * quote editor text, a file name or a secret (`JSON.parse`, a thrown string, a server reply).
 */
const SAFE_MESSAGES = [
  `Cannot read properties of (?:undefined|null) \\(reading '${PROP}'\\)`,
  `Cannot set properties of (?:undefined|null) \\(setting '${PROP}'\\)`,
  `Cannot read properties of (?:undefined|null)`,
  `can't access property "${PROP}", ${IDENT} is (?:undefined|null)`,
  `${IDENT} is (?:undefined|null)`,
  `undefined is not an object \\(evaluating '${PROP}'\\)`,
  `null is not an object \\(evaluating '${PROP}'\\)`,
  `${IDENT} is not a function`,
  `${IDENT} is not a function\\. \\(In '${IDENT}\\(\\)', '${IDENT}' is (?:undefined|null)\\)`,
  `${IDENT} is not a constructor`,
  `${IDENT} is not iterable`,
  `${IDENT} is not defined`,
  `Can't find variable: ${IDENT}`,
  `Cannot access '${IDENT}' before initialization`,
  `can't access lexical declaration '${IDENT}' before initialization`,
  "Assignment to constant variable\\.",
  "Maximum call stack size exceeded",
  "too much recursion",
  "Invalid array length",
  "Invalid time value",
  "Failed to fetch",
  "NetworkError when attempting to fetch resource\\.",
  "Load failed",
  "The operation was aborted\\.",
  "signal is aborted without reason",
  "The user aborted a request\\.",
  "The request is not allowed by the user agent or the platform in the current context.*",
  "The quota has been exceeded\\.",
  "ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\\.)",
].map((source) => new RegExp(`^${source}$`));

/** The message itself when it is one of the safe templates, else null. */
function safeMessage(text: string): string | null {
  // Engine messages are one line; more lines mean text the code put there.
  let line = text.trim();
  if (line.length > 240 || line.includes("\n")) return null;
  line = line
    .replace(/^(Cannot read properties of (?:undefined|null) \(reading )'.*'(\))$/, `$1'${PROP}'$2`)
    .replace(/^(Cannot set properties of (?:undefined|null) \(setting )'.*'(\))$/, `$1'${PROP}'$2`)
    .replace(/^(can't access property )".*", /, `$1"${PROP}", `)
    .replace(
      /^(undefined|null) is not an object \(evaluating '.*'\)$/,
      `$1 is not an object (evaluating '${PROP}')`,
    );
  return SAFE_MESSAGES.some((pattern) => pattern.test(line)) ? line : null;
}

/** Arbitrary error messages can contain editor text or secrets: only safe templates are kept. */
export function diagnosticError(
  error: unknown,
): Pick<DiagnosticDetails, "message" | "stack" | "errorCode" | "code"> {
  if (!(error instanceof Error)) return { message: "Non-Error rejection (text omitted)" };
  const name = ERROR_NAMES.has(error.name) ? error.name : "Error";
  const kept = safeMessage(error.message);
  const message = kept ? `${name}: ${kept}` : `${name} (text omitted)`;
  const frames = (error.stack ?? "").split("\n");
  const first = frames[0]?.trim() ?? "";
  if (first && !first.startsWith("at ") && !first.includes("@")) frames.shift();
  const stack = frames
    .slice(0, 12)
    .map((frame) => diagnosticLocation(frame.trim().replace(/\)$/, "")))
    .join("\n");
  return {
    message,
    ...(stack ? { stack } : {}),
    ...("code" in error && typeof error.code === "string" && ERRNO_CODES.has(error.code)
      ? { code: error.code }
      : {}),
    ...("code" in error &&
    typeof error.code === "number" &&
    Number.isSafeInteger(error.code) &&
    error.code >= 0
      ? { errorCode: error.code }
      : {}),
  };
}

/** Normalize previously stored messages too, so property keys are removed on the next read. */
function scrubMessage(message: string): string | null {
  if (message === "Non-Error rejection (text omitted)") return message;
  const omitted = message.match(/^(\w+) \(text omitted\)$/);
  if (omitted) return ERROR_NAMES.has(omitted[1] ?? "") ? message : null;
  const split = message.indexOf(": ");
  if (split < 0 || !ERROR_NAMES.has(message.slice(0, split))) return null;
  const text = message.slice(split + 2);
  const safe = safeMessage(text);
  return safe === null ? null : `${message.slice(0, split)}: ${safe}`;
}

const CODES = new Set(
  "network unknown forbidden not_found validation unavailable rate_limited pin_required pin_invalid pending_approval banned expired too_large unauthorized lock_lost ECONNREFUSED ETIMEDOUT ECONNRESET ENOTFOUND EAI_AGAIN EPIPE".split(
    " ",
  ),
);
const REASONS = new Set(
  "kicked deleted provider_initiated reauth unavailable banned not_found unauthorized connecting connected disconnected reconnecting offline normal abnormal network permission".split(
    " ",
  ),
);
/** Defense in depth at every persistence boundary, including data read from localStorage. */
export function scrubDiagnosticDetails(input: unknown): DiagnosticDetails {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: DiagnosticDetails = {};
  if (typeof raw.shareRef === "string" && /^[a-f0-9]{16}$/.test(raw.shareRef))
    out.shareRef = raw.shareRef;
  for (const key of [
    "status",
    "durationMs",
    "worstMs",
    "reconnects",
    "offlineMs",
    "closeCode",
    "line",
    "column",
    "backoffMs",
    "errorCode",
  ] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      out[key] = Math.min(Math.round(value), Number.MAX_SAFE_INTEGER);
  }
  if (typeof raw.route === "string") out.route = diagnosticRoute(raw.route);
  if (
    typeof raw.method === "string" &&
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(raw.method)
  )
    out.method = raw.method;
  if (typeof raw.code === "string") out.code = CODES.has(raw.code) ? raw.code : "unknown";
  const sizeBuckets: DiagnosticSizeBucket[] = ["lt_64k", "64k_1m", "1m_10m", "gte_10m"];
  const countBuckets: DiagnosticCountBucket[] = ["0", "1", "2_5", "6_20", "gte_21"];
  if (
    typeof raw.documentSize === "string" &&
    sizeBuckets.includes(raw.documentSize as DiagnosticSizeBucket)
  )
    out.documentSize = raw.documentSize as DiagnosticSizeBucket;
  if (
    typeof raw.fileCount === "string" &&
    countBuckets.includes(raw.fileCount as DiagnosticCountBucket)
  )
    out.fileCount = raw.fileCount as DiagnosticCountBucket;
  if (
    typeof raw.connectionCount === "string" &&
    countBuckets.includes(raw.connectionCount as DiagnosticCountBucket)
  )
    out.connectionCount = raw.connectionCount as DiagnosticCountBucket;
  if (typeof raw.reason === "string")
    out.reason = REASONS.has(raw.reason) ? raw.reason : "abnormal";
  if (typeof raw.location === "string") out.location = diagnosticLocation(raw.location);
  if (typeof raw.message === "string") {
    // Values are outputs of diagnosticError only; reject arbitrary text, including forged storage.
    out.message = scrubMessage(raw.message) ?? "Error (text omitted)";
  }
  if (typeof raw.stack === "string")
    out.stack = raw.stack.split("\n").slice(0, 12).map(diagnosticLocation).join("\n");
  return out;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const eventFingerprint = (
  source: DiagnosticSource,
  kind: DiagnosticKind,
  level: DiagnosticLevel,
  details: DiagnosticDetails,
) =>
  JSON.stringify({
    source,
    kind,
    level,
    details: {
      ...details,
      durationMs: undefined,
      worstMs: undefined,
      offlineMs: undefined,
      reconnects: undefined,
      backoffMs: undefined,
    },
  });
interface EvictionEntry {
  key: string;
  at: number;
  version: number;
  order: number;
}
const earlier = (a: EvictionEntry, b: EvictionEntry) =>
  a.at < b.at || (a.at === b.at && a.order < b.order);
function heapPush(heap: EvictionEntry[], value: EvictionEntry): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const row = heap[parent];
    if (!row || earlier(row, value)) break;
    heap[index] = row;
    index = parent;
  }
  heap[index] = value;
}
function heapPop(heap: EvictionEntry[]): EvictionEntry | undefined {
  const first = heap[0];
  const tail = heap.pop();
  if (!first || !tail || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    const child =
      right < heap.length && heap[right] && heap[left] && earlier(heap[right], heap[left])
        ? right
        : left;
    const row = heap[child];
    if (!row || earlier(tail, row)) break;
    heap[index] = row;
    index = child;
  }
  heap[index] = tail;
  return first;
}

/** In-memory ring with indexed dedupe, bounded pruning, and a short payload-free timeline. */
export class DiagnosticRing {
  private events = new Map<string, DiagnosticEvent>();
  private eventBytes = new Map<string, number>();
  private versions = new Map<string, number>();
  private evictionHeap: EvictionEntry[] = [];
  private breadcrumbs: DiagnosticBreadcrumb[] = [];
  private breadcrumbKeys = new Set<string>();
  private breadcrumbBytes = 0;
  private usedBytes = 2;
  private lastPrunedAt = 0;
  private order = 0;
  constructor(private readonly now: () => number = Date.now) {}
  get count(): number {
    return this.events.size;
  }
  load(input: unknown): void {
    this.clear();
    const data = Array.isArray(input) ? { events: input } : input;
    if (!data || typeof data !== "object") return;
    const raw = data as { events?: unknown; breadcrumbs?: unknown };
    if (Array.isArray(raw.events)) {
      for (const row of raw.events) {
        const event = this.normalizeEvent(row);
        if (event) this.mergeEvent(event);
      }
    }
    if (Array.isArray(raw.breadcrumbs)) {
      for (const row of raw.breadcrumbs) this.addBreadcrumb(row);
    }
    this.prune(true);
  }
  /** Merge another tab's last persisted snapshot without replacing this tab's newer records. */
  merge(input: unknown): boolean {
    const other = new DiagnosticRing(this.now);
    other.load(input);
    let changed = false;
    for (const event of other.events.values()) changed = this.mergeEvent(event) || changed;
    for (const breadcrumb of other.breadcrumbs) changed = this.addBreadcrumb(breadcrumb) || changed;
    this.prune(true);
    return changed;
  }
  record(
    source: DiagnosticSource,
    kind: DiagnosticKind,
    details: DiagnosticDetails = {},
    level: DiagnosticLevel = "warn",
    at = this.now(),
  ): void {
    this.prune();
    const clean = scrubDiagnosticDetails(details);
    const key = eventFingerprint(source, kind, level, clean);
    const atText = new Date(at).toISOString();
    this.addBreadcrumb({
      kind,
      at: atText,
      ...(clean.status !== undefined ? { status: clean.status } : {}),
      ...(clean.code !== undefined
        ? { code: clean.code }
        : clean.errorCode !== undefined
          ? { code: clean.errorCode }
          : {}),
    });
    const found = this.events.get(key);
    const event: DiagnosticEvent = found
      ? {
          ...found,
          firstAt: atText < found.firstAt ? atText : found.firstAt,
          count: Math.min(found.count + 1, Number.MAX_SAFE_INTEGER),
          lastAt: atText > found.lastAt ? atText : found.lastAt,
          details: {
            ...clean,
            ...(() => {
              const worst = Math.max(
                found.details.worstMs ?? found.details.durationMs ?? 0,
                clean.durationMs ?? clean.worstMs ?? 0,
              );
              return found.details.worstMs !== undefined ||
                found.details.durationMs !== undefined ||
                clean.durationMs !== undefined ||
                clean.worstMs !== undefined
                ? { worstMs: worst }
                : {};
            })(),
          },
        }
      : { source, kind, level, firstAt: atText, lastAt: atText, count: 1, details: clean };
    this.putEvent(key, event);
    this.enforceCaps();
  }
  list(): DiagnosticEvent[] {
    this.prune();
    return structuredClone([...this.events.values()]);
  }
  listBreadcrumbs(): DiagnosticBreadcrumb[] {
    this.prune();
    return structuredClone(this.breadcrumbs);
  }
  snapshot(): { events: DiagnosticEvent[]; breadcrumbs: DiagnosticBreadcrumb[] } {
    return { events: this.list(), breadcrumbs: this.listBreadcrumbs() };
  }
  clear(): void {
    this.events.clear();
    this.eventBytes.clear();
    this.versions.clear();
    this.evictionHeap = [];
    this.breadcrumbs = [];
    this.breadcrumbKeys.clear();
    this.breadcrumbBytes = 0;
    this.usedBytes = 2;
    this.lastPrunedAt = 0;
  }
  private normalizeEvent(row: unknown): DiagnosticEvent | null {
    if (!row || typeof row !== "object") return null;
    const e = row as DiagnosticEvent;
    if (
      !DIAGNOSTIC_KINDS.includes(e.kind) ||
      !["client", "api", "collab"].includes(e.source) ||
      !["warn", "error"].includes(e.level)
    )
      return null;
    const first = Date.parse(e.firstAt);
    const last = Date.parse(e.lastAt);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last > this.now() + 60_000)
      return null;
    return {
      kind: e.kind,
      source: e.source,
      level: e.level,
      firstAt: new Date(first).toISOString(),
      lastAt: new Date(last).toISOString(),
      count: Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 1,
      details: scrubDiagnosticDetails(e.details),
    };
  }
  private addBreadcrumb(input: unknown): boolean {
    if (!input || typeof input !== "object") return false;
    const raw = input as DiagnosticBreadcrumb;
    const at = Date.parse(raw.at);
    if (
      !DIAGNOSTIC_KINDS.includes(raw.kind) ||
      !Number.isFinite(at) ||
      at > this.now() + 60_000 ||
      at < this.now() - DIAGNOSTIC_CAPS.days * 86400_000
    )
      return false;
    const breadcrumb: DiagnosticBreadcrumb = {
      kind: raw.kind,
      at: new Date(at).toISOString(),
      ...(typeof raw.status === "number" && Number.isSafeInteger(raw.status) && raw.status >= 0
        ? { status: raw.status }
        : {}),
      ...(typeof raw.code === "string" && CODES.has(raw.code)
        ? { code: raw.code }
        : typeof raw.code === "number" && Number.isSafeInteger(raw.code) && raw.code >= 0
          ? { code: raw.code }
          : {}),
    };
    const key = JSON.stringify(breadcrumb);
    if (this.breadcrumbKeys.has(key)) return false;
    const beforeBytes = this.breadcrumbBytes;
    this.breadcrumbBytes += bytes(breadcrumb) + (this.breadcrumbs.length ? 1 : 0);
    this.breadcrumbs.push(breadcrumb);
    this.breadcrumbKeys.add(key);
    if (this.breadcrumbs.length > 50) {
      const removed = this.breadcrumbs.shift();
      if (removed) {
        this.breadcrumbKeys.delete(JSON.stringify(removed));
        this.breadcrumbBytes -= bytes(removed) + (this.breadcrumbs.length ? 1 : 0);
      }
    }
    this.usedBytes += this.breadcrumbBytes - beforeBytes;
    while (this.usedBytes > DIAGNOSTIC_CAPS.bytes && this.breadcrumbs.length) {
      const removed = this.breadcrumbs.shift();
      if (!removed) continue;
      this.breadcrumbKeys.delete(JSON.stringify(removed));
      this.breadcrumbBytes -= bytes(removed) + (this.breadcrumbs.length ? 1 : 0);
      this.usedBytes -= bytes(removed) + (this.breadcrumbs.length ? 1 : 0);
    }
    return true;
  }
  private mergeEvent(incoming: DiagnosticEvent): boolean {
    const key = eventFingerprint(incoming.source, incoming.kind, incoming.level, incoming.details);
    const current = this.events.get(key);
    if (!current) {
      this.putEvent(key, structuredClone(incoming));
      return true;
    }
    const firstAt = current.firstAt < incoming.firstAt ? current.firstAt : incoming.firstAt;
    const lastAt = current.lastAt > incoming.lastAt ? current.lastAt : incoming.lastAt;
    const count = Math.max(current.count, incoming.count);
    const worst = Math.max(
      current.details.worstMs ?? current.details.durationMs ?? 0,
      incoming.details.worstMs ?? incoming.details.durationMs ?? 0,
    );
    const hasDuration =
      current.details.worstMs !== undefined ||
      current.details.durationMs !== undefined ||
      incoming.details.worstMs !== undefined ||
      incoming.details.durationMs !== undefined;
    const event: DiagnosticEvent = {
      ...current,
      firstAt,
      lastAt,
      count,
      details: {
        ...current.details,
        ...incoming.details,
        ...(hasDuration ? { worstMs: worst } : {}),
      },
    };
    if (JSON.stringify(event) === JSON.stringify(current)) return false;
    this.putEvent(key, event);
    return true;
  }
  private putEvent(key: string, event: DiagnosticEvent): void {
    const oldBytes = this.eventBytes.get(key);
    if (oldBytes === undefined) this.usedBytes += bytes(event) + (this.events.size ? 1 : 0);
    else this.usedBytes += bytes(event) - oldBytes;
    const size = bytes(event);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.eventBytes.set(key, size);
    this.versions.set(key, version);
    this.events.delete(key);
    this.events.set(key, event);
    heapPush(this.evictionHeap, {
      key,
      at: Date.parse(event.lastAt),
      version,
      order: this.order++,
    });
  }
  private removeEvent(key: string): void {
    const size = this.eventBytes.get(key);
    if (size === undefined) return;
    this.usedBytes -= size + (this.events.size > 1 ? 1 : 0);
    this.events.delete(key);
    this.eventBytes.delete(key);
    this.versions.delete(key);
  }
  private enforceCaps(): void {
    if (this.evictionHeap.length > DIAGNOSTIC_CAPS.events * 4) {
      this.evictionHeap = [];
      for (const [key, event] of this.events)
        heapPush(this.evictionHeap, {
          key,
          at: Date.parse(event.lastAt),
          version: this.versions.get(key) ?? 0,
          order: this.order++,
        });
    }
    while (this.events.size > DIAGNOSTIC_CAPS.events || this.usedBytes > DIAGNOSTIC_CAPS.bytes) {
      let oldest = heapPop(this.evictionHeap);
      while (
        oldest &&
        (this.versions.get(oldest.key) !== oldest.version ||
          this.events.get(oldest.key)?.lastAt !== new Date(oldest.at).toISOString())
      )
        oldest = heapPop(this.evictionHeap);
      if (!oldest) break;
      this.removeEvent(oldest.key);
    }
  }
  private prune(force = false): void {
    const now = this.now();
    if (!force && now - this.lastPrunedAt < 5000) return;
    this.lastPrunedAt = now;
    const cutoff = now - DIAGNOSTIC_CAPS.days * 86400_000;
    for (const [key, event] of this.events)
      if (Date.parse(event.lastAt) < cutoff) this.removeEvent(key);
    const oldBreadcrumbBytes = this.breadcrumbBytes;
    this.breadcrumbs = this.breadcrumbs
      .filter((entry) => Date.parse(entry.at) >= cutoff)
      .slice(-50);
    this.breadcrumbBytes = this.breadcrumbs.reduce(
      (total, entry, index) => total + bytes(entry) + (index ? 1 : 0),
      0,
    );
    this.usedBytes += this.breadcrumbBytes - oldBreadcrumbBytes;
    this.breadcrumbKeys = new Set(this.breadcrumbs.map((entry) => JSON.stringify(entry)));
    this.enforceCaps();
  }
}

export const DIAGNOSTIC_SERVER_CAPS = {
  slots: 16,
  snapshotBytes: 384 * 1024,
  exportEvents: 1000,
  errorMinutes: 1441,
  participants: 1000,
} as const;
export interface DiagnosticSnapshot {
  slot: string;
  source: "api" | "collab";
  bootId: string;
  at: string;
  uptimeSeconds: number;
  documents: number;
  connections: number;
  participants?: Record<string, number>;
  /** Minute-resolution rolling error counts, independent of deduplicated 14-day events. */
  errorMinutes?: [number, number][];
  events: DiagnosticEvent[];
  breadcrumbs: DiagnosticBreadcrumb[];
}
export interface AdminShare {
  id: string;
  title: string;
  language: string;
  ownerKind: "signed_in" | "unknown" | "lab";
  saved: boolean;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  sizeBytes: number;
  participants: number | null;
  locked: boolean;
}
export interface AdminOverview {
  shares: number;
  onlineUsers: number;
  documents: number;
  connections: number;
  storageBytes: number;
  quotaBytes: number;
  uptimeSeconds: number;
  version: string;
  errors24h: number;
  activity: number[];
  health: { mongo: boolean; valkey: boolean; collab: "healthy" | "unknown" };
}
export interface AdminSecurity {
  cidrRestricted: boolean;
  proxyRestricted: boolean;
  loginPerMinute: number;
  apiPerMinute: number;
  failedLogins: DiagnosticEvent[];
}
export interface ServerDiagnosticBundle {
  format: 1;
  header: string;
  exportedAt: string;
  version: string;
  uptimeSeconds: number;
  caps: typeof DIAGNOSTIC_CAPS;
  serverCaps: typeof DIAGNOSTIC_SERVER_CAPS;
  health: AdminOverview["health"];
  config: Record<string, boolean | number | string>;
  counters: { errors24h: number };
  processes: Array<{
    slot: string;
    source: "api" | "collab";
    bootId: string;
    breadcrumbs: DiagnosticBreadcrumb[];
  }>;
  events: DiagnosticEvent[];
}

/** Bounded mirror boundary: accept known metadata only and scrub events again. */
export function scrubDiagnosticSnapshot(input: DiagnosticSnapshot): DiagnosticSnapshot | null {
  if (
    !/^(api|collab):[0-7]$/.test(input.slot) ||
    !input.slot.startsWith(`${input.source}:`) ||
    !Number.isFinite(Date.parse(input.at))
  )
    return null;
  const ring = new DiagnosticRing();
  ring.load({ events: input.events, breadcrumbs: input.breadcrumbs });
  const integer = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const minMinute = Math.floor(Date.now() / 60_000) - 1440;
  const result: DiagnosticSnapshot = {
    slot: input.slot,
    source: input.source,
    bootId:
      typeof input.bootId === "string" && /^[a-f0-9-]{16,36}$/.test(input.bootId)
        ? input.bootId
        : "unknown",
    at: new Date(input.at).toISOString(),
    uptimeSeconds: integer(input.uptimeSeconds),
    documents: integer(input.documents),
    connections: integer(input.connections),
    participants: Object.fromEntries(
      Object.entries(input.participants ?? {})
        .filter(
          ([key, value]) => /^[a-f0-9]{16}$/.test(key) && Number.isSafeInteger(value) && value >= 0,
        )
        .slice(0, DIAGNOSTIC_SERVER_CAPS.participants),
    ),
    errorMinutes: (input.errorMinutes ?? [])
      .filter(
        ([minute, count]) =>
          Number.isSafeInteger(minute) &&
          minute >= minMinute &&
          minute <= minMinute + 1440 &&
          Number.isSafeInteger(count) &&
          count >= 0,
      )
      .slice(-DIAGNOSTIC_SERVER_CAPS.errorMinutes),
    events: ring.list(),
    breadcrumbs: ring.listBreadcrumbs(),
  };
  while (bytes(result) > DIAGNOSTIC_SERVER_CAPS.snapshotBytes && result.events.length)
    result.events.shift();
  return result;
}
