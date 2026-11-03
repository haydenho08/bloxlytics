import { randomUUID } from "node:crypto";
import { createGame, createPool, runMigrations, type Pool } from "@bloxlytics/db";
import { encodeStreamEvent, STREAM_EVENT_FIELD, type StreamEvent } from "@bloxlytics/shared";
import { Redis } from "ioredis";
import { pino } from "pino";
import type { ConsumerConfig } from "../src/config.ts";
import { EventWorker } from "../src/worker.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bloxlytics:bloxlytics@localhost:5433/bloxlytics_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1";

export const GAME_ID = "test-game";
export const STREAM = "bx:test:worker:events";
export const DLQ = "bx:test:worker:dlq";
export const GROUP = "bx-test-workers";

export function consumerConfig(overrides: Partial<ConsumerConfig> = {}): ConsumerConfig {
  return {
    stream: STREAM,
    deadLetterStream: DLQ,
    group: GROUP,
    consumer: "worker-1",
    batchSize: 100,
    blockMs: 50,
    claimIdleMs: 60_000,
    maxDeliveries: 5,
    ...overrides,
  };
}

export interface TestEnv {
  pool: Pool;
  redis: Redis;
  /** A worker with a silent logger. Pass a pool to give it a broken database. */
  worker(overrides?: Partial<ConsumerConfig>, pool?: Pool): Promise<EventWorker>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const pool = createPool(TEST_DATABASE_URL, 4);
  await runMigrations(pool);
  const redis = new Redis(TEST_REDIS_URL);
  const log = pino({ level: "silent" });

  return {
    pool,
    redis,
    async worker(overrides = {}, workerPool = pool) {
      const w = new EventWorker({ pool: workerPool, redis, config: consumerConfig(overrides), log });
      await w.init();
      return w;
    },
    async reset() {
      await pool.query("TRUNCATE games CASCADE");
      await redis.flushdb();
      await createGame(pool, GAME_ID, "Test Game");
    },
    async close() {
      await redis.quit();
      await pool.end();
    },
  };
}

let playerCounter = 2_000_000;

/** A stream event as the API would have written it; override any field. */
export function makeEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  const now = Date.now();
  return {
    event_id: randomUUID(),
    game_id: GAME_ID,
    server_id: "server-1",
    player_id: playerCounter++,
    type: "player_join",
    timestamp: now,
    received_at: now,
    properties: {},
    ...overrides,
  } as StreamEvent;
}

export async function enqueue(redis: Redis, ...events: StreamEvent[]): Promise<void> {
  for (const { received_at, ...event } of events) {
    await redis.xadd(STREAM, "*", STREAM_EVENT_FIELD, encodeStreamEvent(event as StreamEvent, received_at));
  }
}

/** Processes until there's nothing left to read. */
export async function drain(worker: EventWorker): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await worker.processOnce()) === 0) return;
  }
  throw new Error("stream did not drain");
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT (${sql}) AS n`, params);
  return Number(rows[0]!.n);
}
