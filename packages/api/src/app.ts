import type { Pool } from "@gamepulse/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Redis } from "ioredis";
import { ApiKeyAuthenticator } from "./auth.ts";
import type { Config } from "./config.ts";
import { DependencyUnavailableError } from "./errors.ts";
import { defineScripts } from "./redisScripts.ts";
import { eventsRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";

export interface AppDeps {
  config: Config;
  redis: Redis;
  pool: Pool;
  logger?: FastifyServerOptions["logger"];
  authenticator?: ApiKeyAuthenticator;
}

/**
 * Builds the app from things handed to it rather than things it creates itself.
 * main.ts passes real connections; tests pass test databases, tiny rate limits,
 * or a Redis that's deliberately unreachable.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // 100 events x 8 KiB of properties fits comfortably; anything bigger is a bug or abuse.
    bodyLimit: 1024 * 1024,
    // Let callers pass a request id so their logs and ours can be joined up.
    requestIdHeader: "x-request-id",
  });

  defineScripts(deps.redis);
  const authenticator = deps.authenticator ?? new ApiKeyAuthenticator(deps.pool);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DependencyUnavailableError) {
      req.log.error({ err: err.cause, dependency: err.dependency }, "dependency unavailable");
      return reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: `${err.dependency}_unavailable`, message: "Try again shortly" });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) {
      // Fastify's own client errors: bad JSON (400), too large (413), wrong content type (415).
      return reply.code(status).send({ error: (err as { code?: string }).code ?? "bad_request", message: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.register(healthRoutes, { redis: deps.redis, pool: deps.pool });
  app.register(eventsRoutes, { config: deps.config, redis: deps.redis, authenticator });

  return app;
}
