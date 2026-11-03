import { createHash, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { Pool } from "@bloxlytics/db";
import { GAME_ID_PATTERN } from "@bloxlytics/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { LiveFeed } from "./liveFeed.ts";
import { OverviewCache } from "./overviewCache.ts";
import { gameExists } from "./queries.ts";
import { gamesRoutes } from "./routes/games.ts";
import { liveRoutes } from "./routes/live.ts";

export interface AppDeps {
  config: Config;
  pool: Pool;
  feed: LiveFeed;
  /** One logger shared with the live feed. Omitted in tests: silent. */
  logger?: FastifyBaseLogger;
  /** Tests pass a fixed time so "today" doesn't depend on when they run. */
  clock?: () => Date;
}

/**
 * The dashboard's backend. A separate service from the ingestion API on purpose:
 * it reads Postgres, which the ingestion API never touches, and a slow chart
 * query or a crowd of dashboards must never add latency to ingesting events.
 * Each can be scaled, deployed and restarted without the other.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, pool, feed } = deps;
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    requestIdHeader: "x-request-id",
  });
  const overviews = new OverviewCache(pool, config.serverStaleAfterMs, 1000, clock);

  if (config.password) requireBasicAuth(app, config.password);

  // Every /api/games/:gameId/... route: refuse unknown games here, once, rather
  // than returning empty charts that look like a game with no players.
  app.addHook("preHandler", async (req, reply) => {
    const { gameId } = (req.params ?? {}) as { gameId?: string };
    if (gameId === undefined) return;
    if (!GAME_ID_PATTERN.test(gameId) || !(await gameExists(pool, gameId))) {
      return reply.code(404).send({ error: "unknown_game" });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: "bad_request", message: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok", viewers: feed.viewerCount }));
  app.register(gamesRoutes, { pool, overviews, clock });
  app.register(liveRoutes, { feed, overviews, overviewEveryMs: config.liveOverviewMs });
  if (config.staticDir) {
    // One origin for the page and its API: no CORS, and Basic auth covers both.
    app.register(fastifyStatic, { root: resolve(config.staticDir) });
  }

  return app;
}

/**
 * HTTP Basic auth with one shared password: the simplest thing that keeps a
 * deployed dashboard private. Browsers show their own login prompt on a 401 with
 * WWW-Authenticate and then send the header on every request, EventSource
 * included (which can't set headers itself, ruling out a bearer token).
 * Only safe over HTTPS, since the password travels in every request.
 */
function requireBasicAuth(app: FastifyInstance, password: string): void {
  const expected = createHash("sha256").update(password).digest();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":")
      : "";
    // Compare hashes in constant time, so response timing can't leak how much of a guess was right.
    if (!timingSafeEqual(createHash("sha256").update(given).digest(), expected)) {
      return reply.code(401).header("www-authenticate", 'Basic realm="Bloxlytics"').send({ error: "unauthorized" });
    }
  });
}
