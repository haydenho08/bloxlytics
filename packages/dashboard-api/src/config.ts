import { DEFAULT_EVENTS_STREAM } from "@bloxlytics/shared";
import { z } from "zod";

// Same pattern as the API and the worker: parse the environment once, crash at
// boot on a typo.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DASHBOARD_API_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Most hosting platforms say which port to listen on in PORT.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Optional. When set, every request needs HTTP Basic auth with this password.
  // Empty counts as unset (docker-compose passes "" when it isn't defined).
  DASHBOARD_PASSWORD: z.union([z.literal(""), z.string().min(8)]).optional(),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  EVENTS_STREAM: z.string().min(1).default(DEFAULT_EVENTS_STREAM),
  // Must match the worker's, so "online now" agrees with the players-online chart.
  SERVER_STALE_AFTER_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),
  LIVE_OVERVIEW_MS: z.coerce.number().int().min(1000).default(5000),
  // In production, the built React app (packages/dashboard/dist), served from here
  // so the dashboard and its API share one origin. Unset in development (Vite serves it).
  DASHBOARD_STATIC_DIR: z.string().min(1).optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  logLevel: string;
  host: string;
  port: number;
  password: string | undefined;
  databaseUrl: string;
  redisUrl: string;
  stream: string;
  serverStaleAfterMs: number;
  /** How often the live stream pushes fresh headline numbers. */
  liveOverviewMs: number;
  staticDir: string | undefined;
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
    host: e.DASHBOARD_API_HOST,
    port: e.DASHBOARD_API_PORT ?? e.PORT ?? 8082,
    password: e.DASHBOARD_PASSWORD || undefined,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    stream: e.EVENTS_STREAM,
    serverStaleAfterMs: e.SERVER_STALE_AFTER_MS,
    liveOverviewMs: e.LIVE_OVERVIEW_MS,
    staticDir: e.DASHBOARD_STATIC_DIR,
  };
}
