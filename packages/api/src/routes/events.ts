import {
  encodeStreamEvent,
  encodeStreamHeartbeat,
  eventBatch,
  serverHeartbeat,
  STREAM_EVENT_FIELD,
  STREAM_HEARTBEAT_FIELD,
} from "@bloxlytics/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { z } from "zod";
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

  /** 1. Who is this? Replies 401 and returns null if the key is no good. */
  async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const header = req.headers[API_KEY_HEADER];
    const gameId = await withDependency(
      "postgres",
      authenticator.authenticate(typeof header === "string" ? header : undefined),
    );
    if (!gameId) {
      reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-API-Key header" });
    }
    return gameId;
  }

  function sendInvalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
    return reply.code(400).send({
      error: "invalid_batch",
      issues: error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  /** 4. Within this game's budget? Replies 429 and returns false if not. */
  async function takeTokens(reply: FastifyReply, gameId: string, cost: number): Promise<boolean> {
    const [allowed, retryAfterMs] = await withDependency(
      "redis",
      redis.bxTakeTokens(`bx:ratelimit:${gameId}`, config.rateLimit.eventsPerSec, config.rateLimit.burst, cost),
    );
    if (!allowed) {
      reply
        .code(429)
        .header("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
        .send({ error: "rate_limited", retry_after_ms: retryAfterMs });
    }
    return Boolean(allowed);
  }

  /** 5. Enqueue, unless the workers have fallen too far behind. Replies 503 and returns -1 if so. */
  async function enqueue(
    req: FastifyRequest,
    reply: FastifyReply,
    gameId: string,
    field: string,
    entries: string[],
  ): Promise<number> {
    const added = await withDependency(
      "redis",
      redis.bxEnqueue(config.stream.name, config.stream.maxPending, field, ...entries),
    );
    if (added < 0) {
      req.log.warn({ gameId }, "stream full, shedding load");
      reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: "queue_full", message: "Ingestion is backed up; retry later" });
    }
    return added;
  }

  // The whole job of this handler is to decide quickly whether a batch is
  // acceptable and hand it to Redis. No Postgres writes, no aggregation: that's
  // the worker's job, so a slow database never slows down game servers.
  app.post("/v1/events", async (req, reply) => {
    const receivedAt = Date.now();

    const gameId = await authenticate(req, reply);
    if (!gameId) return reply;

    // 2. Is the batch well formed? (400) All-or-nothing: one bad event rejects the batch.
    const parsed = eventBatch.safeParse(req.body);
    if (!parsed.success) return sendInvalid(reply, parsed.error);
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

    // Cost is per event, not per request.
    if (!(await takeTokens(reply, gameId, events.length))) return reply;

    const added = await enqueue(
      req,
      reply,
      gameId,
      STREAM_EVENT_FIELD,
      events.map((e) => encodeStreamEvent(e, receivedAt)),
    );
    if (added < 0) return reply;

    req.log.debug({ gameId, events: added }, "batch enqueued");
    return reply.code(202).send({ accepted: added });
  });

  // "Still alive, nothing to report." Goes through the stream like events do, so
  // the worker sees heartbeats and events in the order they arrived, and the API
  // still never writes to Postgres.
  app.post("/v1/heartbeat", async (req, reply) => {
    const receivedAt = Date.now();

    const gameId = await authenticate(req, reply);
    if (!gameId) return reply;

    const parsed = serverHeartbeat.safeParse(req.body);
    if (!parsed.success) return sendInvalid(reply, parsed.error);
    if (parsed.data.game_id !== gameId) {
      return reply.code(403).send({ error: "game_id_mismatch", message: `API key belongs to "${gameId}"` });
    }

    // Costs one event's worth, so heartbeats can't be used to get around the limit.
    if (!(await takeTokens(reply, gameId, 1))) return reply;
    const added = await enqueue(req, reply, gameId, STREAM_HEARTBEAT_FIELD, [
      encodeStreamHeartbeat(parsed.data, receivedAt),
    ]);
    if (added < 0) return reply;

    return reply.code(202).send({ accepted: 1 });
  });
};
