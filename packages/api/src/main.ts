import { createPool } from "@bloxlytics/db";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createRedis } from "./redis.ts";

const config = loadConfig();

const logger = {
  level: config.logLevel,
  // Never let a key end up in a log line, even if someone later logs headers.
  redact: ['req.headers["x-api-key"]', "req.headers.authorization"],
  // JSON in production (for log tooling); human-readable when developing in a terminal.
  ...(config.env === "development" && process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } } }
    : {}),
};

const pool = createPool(config.databaseUrl, 5);
const redis = createRedis(config.redisUrl);
await redis.connect();

const app = buildApp({ config, redis, pool, logger });

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down: no new connections, finishing in-flight requests");

  // If something hangs (a stuck connection), don't wait forever.
  setTimeout(() => {
    app.log.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    // Stops accepting connections and resolves once in-flight requests finish.
    // Redis and Postgres close only after that, since those requests still need them.
    await app.close();
    await redis.quit();
    await pool.end();
    app.log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

await app.listen({ host: config.host, port: config.port });
