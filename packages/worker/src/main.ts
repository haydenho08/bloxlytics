import { setTimeout as sleep } from "node:timers/promises";
import { createPool } from "@gamepulse/db";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadConfig } from "./config.ts";
import { refreshRollups } from "./rollups.ts";
import { EventWorker } from "./worker.ts";

const config = loadConfig();

const log = pino({
  level: config.logLevel,
  base: { consumer: config.consumer.consumer },
  ...(config.env === "development" && process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } } }
    : {}),
});

const pool = createPool(config.databaseUrl, 5);
// Unlike the API, the worker has nobody waiting on it, so it's fine for commands
// to wait a moment for a reconnect rather than fail instantly.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

const worker = new EventWorker({ pool, redis, config: config.consumer, log });
const stop = new AbortController();

async function rollupLoop(): Promise<void> {
  while (!stop.signal.aborted) {
    try {
      const ran = await refreshRollups(pool, config.rollups);
      log.debug({ ran }, "rollup refresh");
    } catch (err) {
      log.error({ err }, "rollup refresh failed");
    }
    await sleep(config.rollupRefreshMs, undefined, { signal: stop.signal }).catch(() => {});
  }
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

function shutdown(signal: string): void {
  if (stop.signal.aborted) return;
  log.info({ signal }, "shutting down: finishing the batch in hand");
  setTimeout(() => {
    log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  stop.abort();
  worker.stop();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}

log.info({ stream: config.consumer.stream, group: config.consumer.group }, "worker starting");
try {
  // Both loops return once stopped, after finishing (and acknowledging) their
  // current work. Only then are the connections closed.
  await Promise.all([worker.run(), rollupLoop()]);
  await redis.quit();
  await pool.end();
  log.info("shutdown complete");
  process.exit(0);
} catch (err) {
  log.fatal({ err }, "worker crashed");
  process.exit(1);
}
