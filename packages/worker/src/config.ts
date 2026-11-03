import { hostname } from "node:os";
import { DEFAULT_DEAD_LETTER_STREAM, DEFAULT_EVENTS_STREAM } from "@bloxlytics/shared";
import { z } from "zod";

// Same idea as the API: parse the environment once, crash at boot on a typo.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  EVENTS_STREAM: z.string().min(1).default(DEFAULT_EVENTS_STREAM),
  DEAD_LETTER_STREAM: z.string().min(1).default(DEFAULT_DEAD_LETTER_STREAM),
  WORKER_GROUP: z.string().min(1).default("bx-workers"),
  // Unique per process, so each worker's pending entries are its own.
  WORKER_CONSUMER: z.string().min(1).default(`${hostname()}-${process.pid}`),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(500),
  WORKER_BLOCK_MS: z.coerce.number().int().min(100).default(2000),
  WORKER_CLAIM_IDLE_MS: z.coerce.number().int().min(1000).default(60_000),
  WORKER_MAX_DELIVERIES: z.coerce.number().int().min(1).default(5),
  ROLLUP_REFRESH_MS: z.coerce.number().int().min(1000).default(15_000),
  ONLINE_WINDOW_MINUTES: z.coerce.number().int().min(1).default(60),
  SERVER_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),
});

export interface Config {
  env: "development" | "test" | "production";
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  consumer: ConsumerConfig;
  rollups: RollupConfig;
  rollupRefreshMs: number;
}

export interface ConsumerConfig {
  stream: string;
  deadLetterStream: string;
  group: string;
  consumer: string;
  /** Most entries read (and stored in one transaction) at a time. */
  batchSize: number;
  /** How long one XREADGROUP waits for new entries. Also bounds how long shutdown waits. */
  blockMs: number;
  /** An entry pending this long belongs to a worker that died; another may take it over. */
  claimIdleMs: number;
  /** Delivered this many times and still not acknowledged: give up and dead-letter it. */
  maxDeliveries: number;
}

export interface RollupConfig {
  /** How far back players-online is recomputed, to absorb late events. */
  onlineWindowMinutes: number;
  /** A server quiet for this long is treated as gone, and its open sessions as ended. */
  serverStaleAfterMs: number;
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
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    consumer: {
      stream: e.EVENTS_STREAM,
      deadLetterStream: e.DEAD_LETTER_STREAM,
      group: e.WORKER_GROUP,
      consumer: e.WORKER_CONSUMER,
      batchSize: e.WORKER_BATCH_SIZE,
      blockMs: e.WORKER_BLOCK_MS,
      claimIdleMs: e.WORKER_CLAIM_IDLE_MS,
      maxDeliveries: e.WORKER_MAX_DELIVERIES,
    },
    rollups: {
      onlineWindowMinutes: e.ONLINE_WINDOW_MINUTES,
      serverStaleAfterMs: e.SERVER_STALE_AFTER_MS,
    },
    rollupRefreshMs: e.ROLLUP_REFRESH_MS,
  };
}
