import { UPDATE_CHANNELS, type UpdateChannel } from "@codesh/shared";
import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me";

const envSchema = z.object({
  QUOTA_WINDOW_SECONDS: z.coerce.number().int().positive().default(86400),
  QUOTA_SHARES_PER_CLIENT: z.coerce.number().int().positive().default(200),
  QUOTA_SHARES_PER_IP: z.coerce.number().int().positive().default(1000),
  QUOTA_UPLOADS_PER_CLIENT: z.coerce.number().int().positive().default(200),
  QUOTA_UPLOADS_PER_IP: z.coerce.number().int().positive().default(1000),
  QUOTA_BYTES_PER_CLIENT: z.coerce.number().int().positive().default(536870912),
  QUOTA_BYTES_PER_IP: z.coerce.number().int().positive().default(2147483648),
  UPLOAD_STORAGE_MAX_BYTES: z.coerce.number().int().positive().default(10737418240),
  SSE_MAX_PER_CLIENT: z.coerce.number().int().positive().default(20),
  SSE_MAX_PER_IP: z.coerce.number().int().positive().default(200),
  PRESENCE_MAX_PER_NET: z.coerce.number().int().positive().default(500),
  PENDING_MAX_PER_SHARE: z.coerce.number().int().positive().default(100),
  BROADCASTS_PER_MIN: z.coerce.number().int().positive().default(5),
  BROADCAST_FANOUT_MAX: z.coerce.number().int().positive().default(500),
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /** `memory` keeps everything in the process: for local experiments, never for real data. */
  STORAGE: z.enum(["mongo", "memory"]).default("mongo"),
  MONGO_URL: z.string().default("mongodb://localhost:27017/codesh"),
  VALKEY_URL: z.string().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().default(DEV_SECRET),
  COLLAB_SECRET: z.string().default(DEV_SECRET),
  /** Empty disables the admin API. */
  ADMIN_TOKEN: z.string().default(""),
  /** Comma-separated CIDRs of reverse proxies whose X-Forwarded-For is trusted. */
  TRUST_PROXY: z.string().default(""),
  /** Origin users reach the app on, e.g. https://codesh.corp. Used for OIDC redirect URIs. */
  PUBLIC_URL: z.string().default(""),
  /** Requests per client IP and minute, per bucket. */
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().positive().default(1200),
  RATE_LIMIT_CODE_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_CREATE_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(10),
  /** Asks GitHub for the latest release now and then; `off` makes no outbound request at all. */
  UPDATE_CHECK: z
    .string()
    .default("on")
    .transform((value) => !/^(off|false|0|no)$/i.test(value.trim())),
  UPDATE_REPO: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "UPDATE_REPO must look like owner/name")
    .default("kim0040/codesh"),
  UPDATE_CHANNEL: z.enum(UPDATE_CHANNELS).default("stable"),
  /** Base URL of the GitHub REST API; replaced in tests. */
  UPDATE_API_URL: z.url({ protocol: /^https?$/ }).default("https://api.github.com"),
  /** deploy/state/update.json as mounted into the container; empty when there is none. */
  UPDATE_STATUS_FILE: z.string().default(""),
});

export interface RateLimits {
  apiPerMinute: number;
  codePerMinute: number;
  createPerMinute: number;
  loginPerMinute: number;
}

export interface SecurityLimits {
  QUOTA_WINDOW_SECONDS: number;
  QUOTA_SHARES_PER_CLIENT: number;
  QUOTA_SHARES_PER_IP: number;
  QUOTA_UPLOADS_PER_CLIENT: number;
  QUOTA_UPLOADS_PER_IP: number;
  QUOTA_BYTES_PER_CLIENT: number;
  QUOTA_BYTES_PER_IP: number;
  UPLOAD_STORAGE_MAX_BYTES: number;
  SSE_MAX_PER_CLIENT: number;
  SSE_MAX_PER_IP: number;
  PRESENCE_MAX_PER_NET: number;
  PENDING_MAX_PER_SHARE: number;
  BROADCASTS_PER_MIN: number;
  BROADCAST_FANOUT_MAX: number;
}

export interface UpdateConfig {
  enabled: boolean;
  repo: string;
  channel: UpdateChannel;
  apiUrl: string;
  statusFile: string;
}

export interface Config {
  production: boolean;
  host: string;
  port: number;
  storage: "mongo" | "memory";
  mongoUrl: string;
  valkeyUrl: string;
  sessionSecret: string;
  collabSecret: string;
  adminToken: string;
  trustProxy: string[];
  publicUrl: string;
  rateLimit: RateLimits;
  limits: SecurityLimits;
  update: UpdateConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  if (production) {
    for (const name of ["SESSION_SECRET", "COLLAB_SECRET"] as const) {
      if (parsed[name] === DEV_SECRET || parsed[name].length < 32) {
        throw new Error(`${name} must be set to at least 32 characters in production`);
      }
    }
  }
  return {
    production,
    host: parsed.HOST,
    port: parsed.PORT,
    storage: parsed.STORAGE,
    mongoUrl: parsed.MONGO_URL,
    valkeyUrl: parsed.VALKEY_URL,
    sessionSecret: parsed.SESSION_SECRET,
    collabSecret: parsed.COLLAB_SECRET,
    adminToken: parsed.ADMIN_TOKEN,
    trustProxy: parsed.TRUST_PROXY.split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    publicUrl: parsed.PUBLIC_URL.replace(/\/+$/, ""),
    limits: {
      QUOTA_WINDOW_SECONDS: parsed.QUOTA_WINDOW_SECONDS,
      QUOTA_SHARES_PER_CLIENT: parsed.QUOTA_SHARES_PER_CLIENT,
      QUOTA_SHARES_PER_IP: parsed.QUOTA_SHARES_PER_IP,
      QUOTA_UPLOADS_PER_CLIENT: parsed.QUOTA_UPLOADS_PER_CLIENT,
      QUOTA_UPLOADS_PER_IP: parsed.QUOTA_UPLOADS_PER_IP,
      QUOTA_BYTES_PER_CLIENT: parsed.QUOTA_BYTES_PER_CLIENT,
      QUOTA_BYTES_PER_IP: parsed.QUOTA_BYTES_PER_IP,
      UPLOAD_STORAGE_MAX_BYTES: parsed.UPLOAD_STORAGE_MAX_BYTES,
      SSE_MAX_PER_CLIENT: parsed.SSE_MAX_PER_CLIENT,
      SSE_MAX_PER_IP: parsed.SSE_MAX_PER_IP,
      PRESENCE_MAX_PER_NET: parsed.PRESENCE_MAX_PER_NET,
      PENDING_MAX_PER_SHARE: parsed.PENDING_MAX_PER_SHARE,
      BROADCASTS_PER_MIN: parsed.BROADCASTS_PER_MIN,
      BROADCAST_FANOUT_MAX: parsed.BROADCAST_FANOUT_MAX,
    },
    update: {
      enabled: parsed.UPDATE_CHECK,
      repo: parsed.UPDATE_REPO,
      channel: parsed.UPDATE_CHANNEL,
      apiUrl: parsed.UPDATE_API_URL.replace(/\/+$/, ""),
      statusFile: parsed.UPDATE_STATUS_FILE,
    },
    rateLimit: {
      apiPerMinute: parsed.RATE_LIMIT_API_PER_MIN,
      codePerMinute: parsed.RATE_LIMIT_CODE_PER_MIN,
      createPerMinute: parsed.RATE_LIMIT_CREATE_PER_MIN,
      loginPerMinute: parsed.RATE_LIMIT_LOGIN_PER_MIN,
    },
  };
}

/**
 * Problems of a production setup that still starts. Behind a reverse proxy an empty TRUST_PROXY
 * makes every client the proxy's address: one rate-limit bucket, one PIN counter, one network group.
 */
export function proxyWarnings(config: Config): string[] {
  if (!config.production || config.trustProxy.length > 0) return [];
  return [
    "TRUST_PROXY is empty: every client is seen with the address of the connection. Behind a reverse proxy set TRUST_PROXY to its CIDR, or all users share one rate limit, one PIN counter and one network group.",
  ];
}
