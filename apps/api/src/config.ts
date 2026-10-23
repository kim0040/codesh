import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  MONGO_URL: z.string().default("mongodb://localhost:27017/codesh"),
  VALKEY_URL: z.string().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().default(DEV_SECRET),
  COLLAB_SECRET: z.string().default(DEV_SECRET),
  /** Empty disables the admin API. */
  ADMIN_TOKEN: z.string().default(""),
  /** Comma-separated CIDRs of reverse proxies whose X-Forwarded-For is trusted. */
  TRUST_PROXY: z.string().default(""),
});

export interface Config {
  production: boolean;
  host: string;
  port: number;
  mongoUrl: string;
  valkeyUrl: string;
  sessionSecret: string;
  collabSecret: string;
  adminToken: string;
  trustProxy: string[];
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
    mongoUrl: parsed.MONGO_URL,
    valkeyUrl: parsed.VALKEY_URL,
    sessionSecret: parsed.SESSION_SECRET,
    collabSecret: parsed.COLLAB_SECRET,
    adminToken: parsed.ADMIN_TOKEN,
    trustProxy: parsed.TRUST_PROXY.split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean),
  };
}
