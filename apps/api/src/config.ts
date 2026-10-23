import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me";

const envSchema = z.object({
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
});

export interface RateLimits {
  apiPerMinute: number;
  codePerMinute: number;
  createPerMinute: number;
  loginPerMinute: number;
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
