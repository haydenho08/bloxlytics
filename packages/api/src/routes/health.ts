import type { Pool } from "@bloxlytics/db";
import type { FastifyPluginAsync } from "fastify";
import type { Redis } from "ioredis";

interface HealthDeps {
  redis: Redis;
  pool: Pool;
}

const CHECK_TIMEOUT_MS = 1000;

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

async function check(work: () => Promise<unknown>): Promise<"ok" | "error"> {
  try {
    await withTimeout(work());
    return "ok";
  } catch {
    return "error";
  }
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, { redis, pool }) => {
  let draining = false;
  app.addHook("preClose", async () => {
    draining = true;
  });

  // Liveness: is the process up and serving HTTP? Never checks dependencies, so a
  // Redis blip doesn't make an orchestrator kill and restart healthy API processes.
  app.get("/health", async () => ({ status: "ok" }));

  // Readiness: should traffic be sent here right now? Fails while Redis or Postgres
  // is unreachable, and while shutting down so a load balancer stops routing to us.
  app.get("/ready", async (_req, reply) => {
    const checks = {
      redis: await check(() => redis.ping()),
      postgres: await check(() => pool.query("SELECT 1")),
    };
    const ready = !draining && checks.redis === "ok" && checks.postgres === "ok";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", draining, checks });
  });
};
