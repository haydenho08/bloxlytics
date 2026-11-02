import { createPool } from "@gamepulse/db";
import { STREAM_EVENT_FIELD } from "@gamepulse/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeEvents } from "../src/store.ts";
import { count, createTestEnv, DLQ, drain, enqueue, GROUP, makeEvent, STREAM, type TestEnv } from "./helpers.ts";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.reset();
});

async function pendingCount(): Promise<number> {
  const [n] = (await env.redis.xpending(STREAM, GROUP)) as [number];
  return n;
}

async function deadLetters(): Promise<Record<string, string>[]> {
  const entries = await env.redis.xrange(DLQ, "-", "+");
  return entries.map(([, fields]) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
    return out;
  });
}

/** Reads entries as a consumer that then "crashes": they stay pending under its name. */
async function readAndCrash(consumer: string): Promise<string[]> {
  const res = (await env.redis.xreadgroup("GROUP", GROUP, consumer, "STREAMS", STREAM, ">")) as
    | [string, [string, string[]][]][]
    | null;
  return (res?.[0]?.[1] ?? []).map(([id]) => id);
}

describe("worker: storing events", () => {
  it("stores every event, acknowledges it, and trims the stream", async () => {
    const worker = await env.worker();
    await enqueue(env.redis, makeEvent(), makeEvent({ type: "custom", name: "boss_killed" }), makeEvent());

    await drain(worker);

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(3);
    expect(await count(env.pool, "SELECT count(*) FROM events WHERE name = 'boss_killed'")).toBe(1);
    expect(await pendingCount()).toBe(0);
    // The API's backpressure check counts XLEN, so acknowledged entries must go.
    expect(await env.redis.xlen(STREAM)).toBe(0);
  });

  it("counts the same event only once when it is sent twice", async () => {
    const worker = await env.worker();
    const join = makeEvent({ type: "player_join" });
    const purchase = makeEvent({
      type: "purchase",
      player_id: join.player_id,
      properties: { product_id: 7, robux: 100 },
    });

    // An SDK retry: the same batch twice. Then the same events again in a later read.
    await enqueue(env.redis, join, purchase, join, purchase);
    await drain(worker);
    await enqueue(env.redis, join, purchase);
    await drain(worker);

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(2);
    expect(await count(env.pool, "SELECT users FROM daily_active_users")).toBe(1);
    expect(await count(env.pool, "SELECT robux FROM revenue_daily")).toBe(100);
    expect(await count(env.pool, "SELECT purchases FROM revenue_daily")).toBe(1);
    expect(await count(env.pool, "SELECT count(*) FROM player_sessions")).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("does not double count when a worker crashes after committing but before acknowledging", async () => {
    const purchase = makeEvent({ type: "purchase", properties: { product_id: "sword", robux: 250 } });
    await enqueue(env.redis, purchase);

    // Worker A reads the entry and commits it to Postgres, then dies before XACK.
    await env.worker({ consumer: "worker-a" });
    await readAndCrash("worker-a");
    await storeEvents(env.pool, [purchase]);
    expect(await pendingCount()).toBe(1);

    // Worker B notices the entry has been idle too long, takes it over, and stores it again.
    const b = await env.worker({ consumer: "worker-b", claimIdleMs: 50 });
    await new Promise((r) => setTimeout(r, 100));
    await drain(b);

    expect(await pendingCount()).toBe(0);
    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(1);
    expect(await count(env.pool, "SELECT robux FROM revenue_daily")).toBe(250);
  });
});

describe("worker: failures", () => {
  it("does not acknowledge anything until Postgres has committed", async () => {
    const deadDb = createPool("postgres://gamepulse:gamepulse@127.0.0.1:1/nowhere", 1);
    const broken = await env.worker({}, deadDb);
    await enqueue(env.redis, makeEvent(), makeEvent());

    await expect(broken.processOnce()).rejects.toThrow();
    expect(await pendingCount()).toBe(2);
    // It retries the same batch in place, renewing its claim without bumping the
    // delivery count, so an outage doesn't push good events towards the dead letter stream.
    await expect(broken.processOnce()).rejects.toThrow();
    const pending = (await env.redis.xpending(STREAM, GROUP, "-", "+", 10)) as [string, string, number, number][];
    expect(pending.map(([, , , deliveries]) => deliveries)).toEqual([1, 1]);
    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(0);
    await deadDb.end();

    // The database is back (a healthy worker takes over): everything is stored.
    const healthy = await env.worker({ consumer: "worker-2", claimIdleMs: 50 });
    await new Promise((r) => setTimeout(r, 100));
    await drain(healthy);
    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(2);
    expect(await pendingCount()).toBe(0);
  });

  it("dead-letters malformed entries and stores the rest", async () => {
    const worker = await env.worker();
    await env.redis.xadd(STREAM, "*", STREAM_EVENT_FIELD, "{not json");
    await env.redis.xadd(STREAM, "*", STREAM_EVENT_FIELD, JSON.stringify({ ...makeEvent(), event_id: "nope" }));
    await enqueue(env.redis, makeEvent());

    await drain(worker);

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(1);
    const dead = await deadLetters();
    expect(dead.map((d) => d.reason)).toEqual(["invalid", "invalid"]);
    expect(dead[0]![STREAM_EVENT_FIELD]).toBe("{not json");
    expect(await pendingCount()).toBe(0);
  });

  it("isolates an event the database rejects so the rest of its batch is stored", async () => {
    const worker = await env.worker();
    const orphan = makeEvent({ game_id: "deleted-game" }); // fails the games foreign key
    await enqueue(env.redis, makeEvent(), orphan, makeEvent());

    await drain(worker);

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(2);
    const dead = await deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.reason).toBe("rejected");
    expect(dead[0]!.error).toMatch(/foreign key/);
    expect(JSON.parse(dead[0]![STREAM_EVENT_FIELD]!).event_id).toBe(orphan.event_id);
    expect(await pendingCount()).toBe(0);
  });

  it("dead-letters an entry that has been delivered too many times", async () => {
    await env.worker();
    const poison = makeEvent();
    await enqueue(env.redis, poison);
    // Each worker that picks it up crashes: delivered once by XREADGROUP, once more by a claim.
    const [id] = await readAndCrash("crashy-1");
    await env.redis.xclaim(STREAM, GROUP, "crashy-2", 0, id!);

    const worker = await env.worker({ consumer: "worker-3", claimIdleMs: 50, maxDeliveries: 2 });
    await new Promise((r) => setTimeout(r, 100));
    await drain(worker);

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(0);
    const dead = await deadLetters();
    expect(dead.map((d) => d.reason)).toEqual(["too_many_deliveries"]);
    expect(dead[0]!.source_id).toBe(id);
    expect(await pendingCount()).toBe(0);
  });
});

describe("worker: trimming", () => {
  it("keeps entries another consumer group hasn't acknowledged yet", async () => {
    await env.redis.xgroup("CREATE", STREAM, "slow-group", "0", "MKSTREAM");
    const worker = await env.worker();
    await enqueue(env.redis, makeEvent(), makeEvent());

    await drain(worker);

    expect(await pendingCount()).toBe(0);
    expect(await env.redis.xlen(STREAM)).toBe(2);
  });

  it("keeps entries that are still pending", async () => {
    const worker = await env.worker();
    await enqueue(env.redis, makeEvent());
    await readAndCrash("crashy");
    await enqueue(env.redis, makeEvent(), makeEvent());

    await drain(worker);

    // The worker stored and acknowledged the two new entries, but the crashed
    // consumer's entry is older than them and still pending, so nothing can go yet.
    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(2);
    expect(await env.redis.xlen(STREAM)).toBe(3);
  });
});

describe("worker: shutdown", () => {
  it("finishes, stops, and leaves the consumer group when asked to stop", async () => {
    const worker = await env.worker();
    await enqueue(env.redis, makeEvent(), makeEvent());
    const running = worker.run();
    await new Promise((r) => setTimeout(r, 300));

    worker.stop();
    await running;

    expect(await count(env.pool, "SELECT count(*) FROM events")).toBe(2);
    expect(await pendingCount()).toBe(0);
    const consumers = (await env.redis.xinfo("CONSUMERS", STREAM, GROUP)) as unknown[];
    expect(consumers).toHaveLength(0);
  });
});
