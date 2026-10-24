import { hostname } from "node:os";
import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3002),
  MONGO_URL: z.string().default("mongodb://localhost:27017/codesh"),
  VALKEY_URL: z.string().default("redis://localhost:6379"),
  COLLAB_SECRET: z.string().default(DEV_SECRET),
  /** Must stay the same across restarts of one instance and differ between instances. */
  COLLAB_INSTANCE_ID: z.string().max(200).optional(),
  /** Tuning only (docs/OPERATIONS.md §11): broadcast window of a busy document, 0 turns it off. */
  COLLAB_BROADCAST_WINDOW_MS: z.coerce.number().int().min(0).max(200).optional(),
});

export interface Config {
  production: boolean;
  host: string;
  port: number;
  mongoUrl: string;
  valkeyUrl: string;
  collabSecret: string;
  instanceId: string;
  broadcastWindowMs: number | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  if (production && (parsed.COLLAB_SECRET === DEV_SECRET || parsed.COLLAB_SECRET.length < 32)) {
    throw new Error("COLLAB_SECRET must be set to at least 32 characters in production");
  }
  return {
    production,
    host: parsed.HOST,
    port: parsed.PORT,
    mongoUrl: parsed.MONGO_URL,
    valkeyUrl: parsed.VALKEY_URL,
    collabSecret: parsed.COLLAB_SECRET,
    instanceId: parsed.COLLAB_INSTANCE_ID ?? `${hostname()}:${parsed.PORT}`,
    broadcastWindowMs: parsed.COLLAB_BROADCAST_WINDOW_MS,
  };
}
