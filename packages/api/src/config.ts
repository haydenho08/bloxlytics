import { DEFAULT_EVENTS_STREAM, MAX_BATCH_SIZE } from "@bloxlytics/shared";
import { z } from "zod";

// Parse the environment once at startup. A typo'd or missing variable crashes
// the process immediately with a clear message, instead of failing on request #1.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  EVENTS_STREAM: z.string().min(1).default(DEFAULT_EVENTS_STREAM),
  STREAM_MAX_PENDING: z.coerce.number().int().positive().default(1_000_000),
  RATE_LIMIT_EVENTS_PER_SEC: z.coerce.number().positive().default(500),
  // A bucket smaller than one full batch could never admit that batch.
  RATE_LIMIT_BURST: z.coerce.number().int().min(MAX_BATCH_SIZE).default(2000),
});

export interface Config {
  env: "development" | "test" | "production";
  logLevel: string;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  stream: { name: string; maxPending: number };
  rateLimit: { eventsPerSec: number; burst: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.API_HOST,
    port: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    stream: { name: e.EVENTS_STREAM, maxPending: e.STREAM_MAX_PENDING },
    rateLimit: { eventsPerSec: e.RATE_LIMIT_EVENTS_PER_SEC, burst: e.RATE_LIMIT_BURST },
  };
}
