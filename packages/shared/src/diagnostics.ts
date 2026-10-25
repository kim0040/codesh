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
}

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

/** A name in code (`a`, `view.state`, `this.x`), never free text: no spaces, quotes or symbols. */
const IDENT = String.raw`[A-Za-z_$][\w$]{0,40}(?:\.[A-Za-z_$#][\w$]{0,40}){0,3}`;
/**
 * Engine messages (V8, SpiderMonkey, JavaScriptCore) and a few fixed library messages, whose only
 * variable parts are names from the code. Anything else becomes "(text omitted)": a message can
 * quote editor text, a file name or a secret (`JSON.parse`, a thrown string, a server reply).
 */
const SAFE_MESSAGES = [
  `Cannot read properties of (?:undefined|null) \\(reading '${IDENT}'\\)`,
  `Cannot set properties of (?:undefined|null) \\(setting '${IDENT}'\\)`,
  `Cannot read properties of (?:undefined|null)`,
  `can't access property "${IDENT}", ${IDENT} is (?:undefined|null)`,
  `${IDENT} is (?:undefined|null)`,
  `undefined is not an object \\(evaluating '${IDENT}'\\)`,
  `null is not an object \\(evaluating '${IDENT}'\\)`,
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
  const line = text.trim();
  if (line.length > 240 || line.includes("\n")) return null;
  return SAFE_MESSAGES.some((pattern) => pattern.test(line)) ? line : null;
}

/** Arbitrary error messages can contain editor text or secrets: only safe templates are kept. */
export function diagnosticError(
  error: unknown,
): Pick<DiagnosticDetails, "message" | "stack" | "errorCode"> {
  if (!(error instanceof Error)) return { message: "Non-Error rejection (text omitted)" };
  const name = ERROR_NAMES.has(error.name) ? error.name : "Error";
  const kept = safeMessage(error.message);
  const message = kept ? `${name}: ${kept}` : `${name} (text omitted)`;
  const stack = (error.stack ?? "")
    .split("\n")
    .slice(1, 13)
    .map((frame) => diagnosticLocation(frame.trim().replace(/\)$/, "")))
    .join("\n");
  return {
    message,
    ...(stack ? { stack } : {}),
    ...("code" in error &&
    typeof error.code === "number" &&
    Number.isSafeInteger(error.code) &&
    error.code >= 0
      ? { errorCode: error.code }
      : {}),
  };
}

/** True for exactly the messages diagnosticError can produce. */
function isDiagnosticMessage(message: string): boolean {
  if (message === "Non-Error rejection (text omitted)") return true;
  const omitted = message.match(/^(\w+) \(text omitted\)$/);
  if (omitted) return ERROR_NAMES.has(omitted[1] ?? "");
  const split = message.indexOf(": ");
  if (split < 0 || !ERROR_NAMES.has(message.slice(0, split))) return false;
  const text = message.slice(split + 2);
  return safeMessage(text) === text;
}

const CODES = new Set(
  "network unknown forbidden not_found validation unavailable rate_limited pin_required pin_invalid pending_approval banned expired too_large unauthorized ECONNREFUSED ETIMEDOUT ECONNRESET".split(
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
  if (typeof raw.reason === "string")
    out.reason = REASONS.has(raw.reason) ? raw.reason : "abnormal";
  if (typeof raw.location === "string") out.location = diagnosticLocation(raw.location);
  if (typeof raw.message === "string") {
    // Values are outputs of diagnosticError only; reject arbitrary text, including forged storage.
    out.message = isDiagnosticMessage(raw.message) ? raw.message : "Error (text omitted)";
  }
  if (typeof raw.stack === "string")
    out.stack = raw.stack.split("\n").slice(0, 12).map(diagnosticLocation).join("\n");
  return out;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** In-memory ring with a stable fingerprint that excludes durations; repeated loops keep a max. */
export class DiagnosticRing {
  private events: DiagnosticEvent[] = [];
  private usedBytes = 2;
  constructor(private readonly now: () => number = Date.now) {}
  load(input: unknown): void {
    this.events = [];
    this.usedBytes = 2;
    if (!Array.isArray(input)) return;
    for (const row of input.slice(-DIAGNOSTIC_CAPS.events)) {
      if (!row || typeof row !== "object") continue;
      const e = row as DiagnosticEvent;
      if (
        !DIAGNOSTIC_KINDS.includes(e.kind) ||
        !["client", "api", "collab"].includes(e.source) ||
        !["warn", "error"].includes(e.level)
      )
        continue;
      if (
        !Number.isFinite(Date.parse(e.firstAt)) ||
        !Number.isFinite(Date.parse(e.lastAt)) ||
        Date.parse(e.lastAt) > this.now() + 60_000
      )
        continue;
      this.events.push({
        kind: e.kind,
        source: e.source,
        level: e.level,
        firstAt: new Date(e.firstAt).toISOString(),
        lastAt: new Date(e.lastAt).toISOString(),
        count: Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 1,
        details: scrubDiagnosticDetails(e.details),
      });
    }
    this.usedBytes = bytes(this.events);
    this.prune();
  }
  record(
    source: DiagnosticSource,
    kind: DiagnosticKind,
    details: DiagnosticDetails = {},
    level: DiagnosticLevel = "warn",
  ): void {
    this.prune();
    const clean = scrubDiagnosticDetails(details);
    const fingerprint = (d: DiagnosticDetails) =>
      JSON.stringify({
        ...d,
        durationMs: undefined,
        worstMs: undefined,
        offlineMs: undefined,
        reconnects: undefined,
        backoffMs: undefined,
      });
    const found = this.events.find(
      (e) =>
        e.source === source &&
        e.kind === kind &&
        e.level === level &&
        fingerprint(e.details) === fingerprint(clean),
    );
    const at = new Date(this.now()).toISOString();
    if (found) {
      const beforeBytes = bytes(found);
      found.count = Math.min(found.count + 1, Number.MAX_SAFE_INTEGER);
      found.lastAt = at;
      found.details = {
        ...clean,
        worstMs: Math.max(
          found.details.worstMs ?? found.details.durationMs ?? 0,
          clean.durationMs ?? clean.worstMs ?? 0,
        ),
      };
      this.usedBytes += bytes(found) - beforeBytes;
    } else {
      const event = { source, kind, level, firstAt: at, lastAt: at, count: 1, details: clean };
      this.usedBytes += bytes(event) + (this.events.length ? 1 : 0);
      this.events.push(event);
    }
    this.prune();
  }
  list(): DiagnosticEvent[] {
    this.prune();
    return structuredClone(this.events);
  }
  clear(): void {
    this.events = [];
    this.usedBytes = 2;
  }
  private prune(): void {
    const cutoff = this.now() - DIAGNOSTIC_CAPS.days * 86400_000;
    const live = this.events.filter((e) => Date.parse(e.lastAt) >= cutoff);
    if (live.length !== this.events.length) {
      this.events = live;
      this.usedBytes = bytes(live);
    }
    while (this.events.length > DIAGNOSTIC_CAPS.events || this.usedBytes > DIAGNOSTIC_CAPS.bytes) {
      const removed = this.events.shift();
      if (removed) this.usedBytes -= bytes(removed) + (this.events.length ? 1 : 0);
    }
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
  at: string;
  uptimeSeconds: number;
  documents: number;
  connections: number;
  participants?: Record<string, number>;
  /** Minute-resolution rolling error counts, independent of deduplicated 14-day events. */
  errorMinutes?: [number, number][];
  events: DiagnosticEvent[];
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
  ring.load(input.events);
  const integer = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const minMinute = Math.floor(Date.now() / 60_000) - 1440;
  const result: DiagnosticSnapshot = {
    slot: input.slot,
    source: input.source,
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
  };
  while (bytes(result) > DIAGNOSTIC_SERVER_CAPS.snapshotBytes && result.events.length)
    result.events.shift();
  return result;
}
