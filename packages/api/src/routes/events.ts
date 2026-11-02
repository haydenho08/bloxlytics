import { encodeStreamEvent, eventBatch } from "@gamepulse/shared";
import type { FastifyPluginAsync } from "fastify";
import type { Redis } from "ioredis";
import { API_KEY_HEADER, type ApiKeyAuthenticator } from "../auth.ts";
import type { Config } from "../config.ts";
import { withDependency } from "../errors.ts";

interface EventsDeps {
  config: Config;
  redis: Redis;
  authenticator: ApiKeyAuthenticator;
}

const MAX_REPORTED_ISSUES = 20;

export const eventsRoutes: FastifyPluginAsync<EventsDeps> = async (app, deps) => {
  const { config, redis, authenticator } = deps;

  // The whole job of this handler is to decide quickly whether a batch is
  // acceptable and hand it to Redis. No Postgres writes, no aggregation: that's
  // the worker's job, so a slow database never slows down game servers.
  app.post("/v1/events", async (req, reply) => {
    const receivedAt = Date.now();

    // 1. Who is this? (401)
    const header = req.headers[API_KEY_HEADER];
    const gameId = await withDependency(
      "postgres",
      authenticator.authenticate(typeof header === "string" ? header : undefined),
    );
    if (!gameId) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-API-Key header" });
    }

    // 2. Is the batch well formed? (400) All-or-nothing: one bad event rejects the batch.
    const parsed = eventBatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_batch",
        issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const { events } = parsed.data;

    // 3. A key for game A can't write events for game B. (403)
    const foreign = events.flatMap((e, i) => (e.game_id === gameId ? [] : [i]));
    if (foreign.length > 0) {
      return reply.code(403).send({
        error: "game_id_mismatch",
        message: `API key belongs to "${gameId}"`,
        indexes: foreign,
      });
    }

    // 4. Within this game's budget? Cost is per event, not per request. (429)
    const [allowed, retryAfterMs] = await withDependency(
      "redis",
      redis.gpTakeTokens(
        `gp:ratelimit:${gameId}`,
        config.rateLimit.eventsPerSec,
        config.rateLimit.burst,
        events.length,
      ),
    );
    if (!allowed) {
      return reply
        .code(429)
        .header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
        .send({ error: "rate_limited", retry_after_ms: retryAfterMs });
    }

    // 5. Enqueue, unless the workers have fallen too far behind. (503)
    const added = await withDependency(
      "redis",
      redis.gpEnqueue(
        config.stream.name,
        config.stream.maxPending,
        ...events.map((e) => encodeStreamEvent(e, receivedAt)),
      ),
    );
    if (added < 0) {
      req.log.warn({ gameId }, "stream full, shedding load");
      return reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: "queue_full", message: "Ingestion is backed up; retry later" });
    }

    req.log.debug({ gameId, events: added }, "batch enqueued");
    return reply.code(202).send({ accepted: added });
  });
};
