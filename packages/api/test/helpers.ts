import { randomUUID } from "node:crypto";
import { createGame, createPool, runMigrations, type Pool } from "@gamepulse/db";
import type { GameEventInput } from "@gamepulse/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { buildApp } from "../src/app.ts";
import type { AuthenticatorOptions } from "../src/auth.ts";
import { ApiKeyAuthenticator } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { createRedis } from "../src/redis.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://gamepulse:gamepulse@localhost:5433/gamepulse_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1";

export const GAME_ID = "test-game";
export const OTHER_GAME_ID = "other-game";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    redisUrl: TEST_REDIS_URL,
    stream: { name: "gp:test:events", maxPending: 10_000 },
    rateLimit: { eventsPerSec: 10_000, burst: 10_000 },
    ...overrides,
  };
}

export interface TestEnv {
  pool: Pool;
  redis: Redis;
  apiKey: string;
  otherApiKey: string;
  build(opts?: { config?: Partial<Config>; redis?: Redis; auth?: AuthenticatorOptions }): FastifyInstance;
  /** Wipe games/keys and Redis, then create two games with one key each. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const pool = createPool(TEST_DATABASE_URL, 4);
  await runMigrations(pool);
  const redis = createRedis(TEST_REDIS_URL);
  await redis.connect();
  const apps: FastifyInstance[] = [];

  const env: TestEnv = {
    pool,
    redis,
    apiKey: "",
    otherApiKey: "",
    build(opts = {}) {
      const config = testConfig(opts.config);
      const app = buildApp({
        config,
        redis: opts.redis ?? redis,
        pool,
        authenticator: new ApiKeyAuthenticator(pool, opts.auth),
      });
      apps.push(app);
      return app;
    },
    async reset() {
      await pool.query("TRUNCATE games CASCADE");
      await redis.flushdb();
      env.apiKey = (await createGame(pool, GAME_ID, "Test Game")).apiKey;
      env.otherApiKey = (await createGame(pool, OTHER_GAME_ID, "Other Game")).apiKey;
    },
    async close() {
      await Promise.all(apps.map((a) => a.close()));
      await redis.quit();
      await pool.end();
    },
  };
  return env;
}

let playerCounter = 1_000_000;

/** A valid event; override any field. */
export function makeEvent(overrides: Partial<GameEventInput> = {}): GameEventInput {
  return {
    event_id: randomUUID().toUpperCase(), // like HttpService:GenerateGUID(false)
    game_id: GAME_ID,
    server_id: "server-1",
    player_id: playerCounter++,
    type: "player_join",
    timestamp: Date.now(),
    properties: {},
    ...overrides,
  } as GameEventInput;
}

export function makeBatch(n: number, overrides: Partial<GameEventInput> = {}) {
  return { events: Array.from({ length: n }, () => makeEvent(overrides)) };
}
