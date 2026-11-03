import { createPool } from "@bloxlytics/db";
import { Redis } from "ioredis";
import { pino } from "pino";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { LiveFeed } from "./liveFeed.ts";

const config = loadConfig();

const log = pino({
  level: config.logLevel,
  redact: ["req.headers.authorization"],
  ...(config.env === "development" && process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } } }
    : {}),
});

const pool = createPool(config.databaseUrl, 5);
// The live feed's own connection, since XREAD BLOCK holds it. It keeps retrying
// while Redis is down (charts still work without Redis; only the feed pauses).
const feedRedis = new Redis(config.redisUrl);
const feed = new LiveFeed({ redis: feedRedis, stream: config.stream, log });
await feed.start();

const app = buildApp({ config, pool, feed, logger: log });

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  setTimeout(() => {
    log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    // Ends the live streams (see routes/live.ts), finishes in-flight requests,
    // then the connections they were using.
    await app.close();
    await feed.stop();
    await pool.end();
    log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

await app.listen({ host: config.host, port: config.port });
