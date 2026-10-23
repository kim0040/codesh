/** Limits, TTLs and intervals from docs/ARCHITECTURE.md. Durations carry their unit in the name. */

export const DEFAULT_FILE_ID = "main";

export const ROLES = ["owner", "edit", "view"] as const;
export type Role = (typeof ROLES)[number];

export const ACCESS_LEVELS = ["edit", "view"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const SESSION_COOKIE = "codesh_sid";

// §3 join codes
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_TTL_SECONDS = 24 * 60 * 60;
export const JOIN_CODE_COOLDOWN_SECONDS = 24 * 60 * 60;

// §6 persistence and concurrency
export const FLUSH_INTERVAL_MS = 100;
export const COMPACT_AFTER_UPDATES = 200;
export const HISTORY_SNAPSHOT_INTERVAL_MS = 30_000;
export const UNLOAD_DELAY_MS = 30_000;
export const SLOW_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024;
export const SLOW_CLIENT_CLOSE_CODE = 4408;
export const PERMISSION_APPLY_MS = 100;
export const SWEEPER_INTERVAL_MS = 10 * 60 * 1000;
export const LAST_ACTIVE_WRITE_INTERVAL_MS = 60_000;
export const NEARBY_THROTTLE_MS = 2000;
export const NEARBY_ITEM_TTL_SECONDS = 60;
export const NEARBY_PREVIEW_LINES = 8;
/** §6.11: collab answers a `cmd:<shareId>` request on `cmd-reply:<requestId>` within this time. */
export const COLLAB_COMMAND_TIMEOUT_MS = 5000;
/** Y.Map `meta` title and language are copied into the share record at most this often per doc. */
export const META_MIRROR_THROTTLE_MS = 2000;

/**
 * Upper bound of `settings.maxDocBytes`: a document's full state is stored as one MongoDB document
 * (snapshot or log entry), which BSON limits to 16 MiB.
 */
export const MAX_DOC_BYTES_LIMIT = 12 * 1024 * 1024;
/** Largest WebSocket frame the collab server accepts: a full state of the largest document. */
export const COLLAB_MAX_PAYLOAD_BYTES = MAX_DOC_BYTES_LIMIT + 64 * 1024;
/** History snapshots kept per share (oldest are dropped first), within `historyRetentionDays`. */
export const HISTORY_MAX_SNAPSHOTS = 100;

// §4 awareness
export const AWARENESS_MAX_UPDATES_PER_SECOND = 30;
/** Largest awareness state of one client (JSON) the collab server forwards. */
export const AWARENESS_MAX_STATE_BYTES = 4096;

// §7 presence
export const PRESENCE_USER_TTL_SECONDS = 60;

// §8 sessions and tokens
export const COLLAB_TOKEN_TTL_SECONDS = 10 * 60;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_ATTEMPT_WINDOW_SECONDS = 10 * 60;

// §9.1 SSE
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_PRESENCE_REFRESH_MS = 20_000;

// Field limits for request bodies
export const MAX_TITLE_LENGTH = 200;
export const MAX_NAME_LENGTH = 40;
export const MAX_PATH_LENGTH = 260;
export const MAX_FILES_PER_SHARE = 100;
export const MAX_NOTE_LENGTH = 200;
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 32;
