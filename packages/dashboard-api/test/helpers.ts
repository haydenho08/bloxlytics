import { randomUUID } from "node:crypto";
import { createGame, createPool, runMigrations, type Pool } from "@bloxlytics/db";
import { encodeStreamEvent, STREAM_EVENT_FIELD, type StreamEvent } from "@bloxlytics/shared";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { pino } from "pino";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { LiveFeed } from "../src/liveFeed.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bloxlytics:bloxlytics@localhost:5433/bloxlytics_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1";

export const GAME_ID = "test-game";
export const OTHER_GAME_ID = "other-game";
export const STREAM = "bx:test:dashboard:events";

/** Tests run "at" this instant, so "today" and "the last hour" are fixed. */
export const NOW = new Date("2026-03-10T12:30:20Z");

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    password: undefined,
    databaseUrl: TEST_DATABASE_URL,
    redisUrl: TEST_REDIS_URL,
    stream: STREAM,
    serverStaleAfterMs: 5 * 60_000,
    liveOverviewMs: 1000,
    ...overrides,
  };
}

export interface TestEnv {
  pool: Pool;
  redis: Redis;
  /** A started live feed on its own connection, stopped by close(). */
  feed(): Promise<LiveFeed>;
  build(opts?: { config?: Partial<Config>; feed?: LiveFeed; clock?: () => Date }): FastifyInstance;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const pool = createPool(TEST_DATABASE_URL, 4);
  await runMigrations(pool);
  const redis = new Redis(TEST_REDIS_URL);
  const log = pino({ level: "silent" });
  const apps: FastifyInstance[] = [];
  const feeds: LiveFeed[] = [];
  // Routes that don't stream never touch the feed, so a stopped one will do for them.
  const idleFeed = new LiveFeed({ redis, stream: STREAM, log });

  return {
    pool,
    redis,
    async feed() {
      const feed = new LiveFeed({ redis: new Redis(TEST_REDIS_URL), stream: STREAM, log, blockMs: 100 });
      await feed.start();
      feeds.push(feed);
      return feed;
    },
    build(opts = {}) {
      const app = buildApp({
        config: testConfig(opts.config),
        pool,
        feed: opts.feed ?? idleFeed,
        clock: opts.clock ?? (() => NOW),
      });
      apps.push(app);
      return app;
    },
    async reset() {
      await pool.query("TRUNCATE games CASCADE");
      await redis.flushdb();
      await createGame(pool, GAME_ID, "Test Game");
      await createGame(pool, OTHER_GAME_ID, "Other Game");
    },
    async close() {
      await Promise.all(apps.map((a) => a.close()));
      await Promise.all(feeds.map((f) => f.stop()));
      await redis.quit();
      await pool.end();
    },
  };
}

let playerCounter = 3_000_000;

export function makeEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    event_id: randomUUID(),
    game_id: GAME_ID,
    server_id: "server-1",
    player_id: playerCounter++,
    type: "player_join",
    timestamp: NOW.getTime(),
    received_at: NOW.getTime(),
    properties: {},
    ...overrides,
  } as StreamEvent;
}

/** Adds events to the stream the way the ingestion API does. */
export async function enqueue(redis: Redis, ...events: StreamEvent[]): Promise<void> {
  for (const { received_at, ...event } of events) {
    await redis.xadd(STREAM, "*", STREAM_EVENT_FIELD, encodeStreamEvent(event as StreamEvent, received_at));
  }
}

export interface SseMessage {
  event: string;
  data: unknown;
}

/**
 * Opens an SSE stream and collects its messages, parsing the wire format by hand
 * (what EventSource does in the browser).
 */
export async function openStream(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const messages: SseMessage[] = [];
  const waiters: (() => void)[] = [];

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = block.split("\n");
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (event && data) {
            messages.push({ event, data: JSON.parse(data) });
            for (const wake of waiters.splice(0)) wake();
          }
        }
      }
    } catch {
      // Aborted by close().
    }
  })();

  return {
    res,
    messages,
    /** Resolves once a message matches, or rejects after a timeout. */
    async waitFor(match: (m: SseMessage) => boolean, timeoutMs = 3000): Promise<SseMessage> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("timed out waiting for SSE message");
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    close: () => controller.abort(),
  };
}
