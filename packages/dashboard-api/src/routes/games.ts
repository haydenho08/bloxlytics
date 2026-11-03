import type { Pool } from "@bloxlytics/db";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { dauSeries, listGames, onlineSeries, retentionSeries, revenueSeries } from "../queries.ts";
import type { OverviewCache } from "../overviewCache.ts";

interface GamesDeps {
  pool: Pool;
  overviews: OverviewCache;
  clock: () => Date;
}

// Bounded so one request can't ask for a million generated rows.
const minutesQuery = z.object({ minutes: z.coerce.number().int().min(1).max(24 * 60).default(60) });
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

type GameParams = { Params: { gameId: string }; Querystring: Record<string, string> };

function parseQuery<T>(schema: z.ZodType<T>, query: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(query);
  if (parsed.success) return parsed.data;
  reply.code(400).send({ error: "invalid_query", message: z.prettifyError(parsed.error) });
  return null;
}

/** Charts and headline numbers. The game in the URL is checked to exist before these run (app.ts). */
export const gamesRoutes: FastifyPluginAsync<GamesDeps> = async (app, { pool, overviews, clock }) => {
  app.get("/api/games", async () => listGames(pool));

  app.get<GameParams>("/api/games/:gameId/overview", async (req) => overviews.get(req.params.gameId));

  app.get<GameParams>("/api/games/:gameId/online", async (req, reply) => {
    const q = parseQuery(minutesQuery, req.query, reply);
    return q && onlineSeries(pool, req.params.gameId, clock(), q.minutes);
  });

  app.get<GameParams>("/api/games/:gameId/dau", async (req, reply) => {
    const q = parseQuery(daysQuery, req.query, reply);
    return q && dauSeries(pool, req.params.gameId, clock(), q.days);
  });

  app.get<GameParams>("/api/games/:gameId/revenue", async (req, reply) => {
    const q = parseQuery(daysQuery, req.query, reply);
    return q && revenueSeries(pool, req.params.gameId, clock(), q.days);
  });

  app.get<GameParams>("/api/games/:gameId/retention", async (req, reply) => {
    const q = parseQuery(daysQuery, req.query, reply);
    return q && retentionSeries(pool, req.params.gameId, clock(), q.days);
  });
};
