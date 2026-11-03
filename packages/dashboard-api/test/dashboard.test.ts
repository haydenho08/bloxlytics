import { STREAM_HEARTBEAT_FIELD } from "@bloxlytics/shared";
import type { FeedEvent, Overview } from "@bloxlytics/shared/dashboard";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeEvents } from "../../worker/src/store.ts";
import { createTestEnv, enqueue, GAME_ID, makeEvent, NOW, openStream, OTHER_GAME_ID, STREAM, type TestEnv } from "./helpers.ts";

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

const minute = (iso: string) => new Date(iso).getTime();

describe("games", () => {
  it("lists games by name", async () => {
    const res = await env.build().inject("/api/games");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: OTHER_GAME_ID, name: "Other Game" },
      { id: GAME_ID, name: "Test Game" },
    ]);
  });

  it("404s an unknown or malformed game instead of returning empty charts", async () => {
    const app = env.build();
    expect((await app.inject("/api/games/nope/dau")).statusCode).toBe(404);
    expect((await app.inject("/api/games/NOT%20A%20SLUG/overview")).statusCode).toBe(404);
  });

  it("rejects out-of-range query parameters", async () => {
    const app = env.build();
    expect((await app.inject(`/api/games/${GAME_ID}/online?minutes=5000`)).statusCode).toBe(400);
    expect((await app.inject(`/api/games/${GAME_ID}/dau?days=0`)).statusCode).toBe(400);
    expect((await app.inject(`/api/games/${GAME_ID}/dau?days=abc`)).statusCode).toBe(400);
  });
});

describe("chart series", () => {
  it("players online: one point per minute, gaps filled with 0, ending at the current minute", async () => {
    await env.pool.query(
      `INSERT INTO players_online_minute (game_id, minute, players) VALUES
         ($1, '2026-03-10T12:29:00Z', 5), ($1, '2026-03-10T12:10:00Z', 3),
         ($1, '2026-03-10T11:00:00Z', 9), ($2, '2026-03-10T12:29:00Z', 99)`,
      [GAME_ID, OTHER_GAME_ID],
    );
    const res = await env.build().inject(`/api/games/${GAME_ID}/online?minutes=30`);
    const points = res.json() as { minute: number; players: number }[];

    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({ minute: minute("2026-03-10T12:01:00Z"), players: 0 });
    expect(points.at(-1)).toEqual({ minute: minute("2026-03-10T12:30:00Z"), players: 0 });
    expect(points.find((p) => p.minute === minute("2026-03-10T12:29:00Z"))?.players).toBe(5);
    expect(points.find((p) => p.minute === minute("2026-03-10T12:10:00Z"))?.players).toBe(3);
    // Outside the window, and another game's row, are left out.
    expect(points.reduce((sum, p) => sum + p.players, 0)).toBe(8);
  });

  it("DAU: one point per UTC day as a 'YYYY-MM-DD' string, ending today", async () => {
    await env.pool.query(
      `INSERT INTO daily_active_users (game_id, day, users) VALUES ($1, '2026-03-10', 40), ($1, '2026-03-08', 25)`,
      [GAME_ID],
    );
    const res = await env.build().inject(`/api/games/${GAME_ID}/dau?days=4`);
    expect(res.json()).toEqual([
      { day: "2026-03-07", users: 0 },
      { day: "2026-03-08", users: 25 },
      { day: "2026-03-09", users: 0 },
      { day: "2026-03-10", users: 40 },
    ]);
  });

  it("revenue: robux and purchase counts as numbers, not bigint strings", async () => {
    await env.pool.query(
      `INSERT INTO revenue_daily (game_id, day, robux, purchases) VALUES ($1, '2026-03-09', 3000000000, 12)`,
      [GAME_ID],
    );
    const res = await env.build().inject(`/api/games/${GAME_ID}/revenue?days=2`);
    expect(res.json()).toEqual([
      { day: "2026-03-09", robux: 3_000_000_000, purchases: 12 },
      { day: "2026-03-10", robux: 0, purchases: 0 },
    ]);
  });

  it("retention: keeps null for days not yet measurable, 0-size cohorts for empty days", async () => {
    await env.pool.query(
      `INSERT INTO retention_daily (game_id, cohort_day, cohort_size, d1_retained, d7_retained) VALUES
         ($1, '2026-03-01', 100, 40, 15), ($1, '2026-03-08', 50, 20, NULL), ($1, '2026-03-10', 30, NULL, NULL)`,
      [GAME_ID],
    );
    const res = await env.build().inject(`/api/games/${GAME_ID}/retention?days=10`);
    const points = res.json() as { cohort_day: string }[];
    expect(points).toHaveLength(10);
    expect(points[0]).toEqual({ cohort_day: "2026-03-01", cohort_size: 100, d1_retained: 40, d7_retained: 15 });
    expect(points[1]).toEqual({ cohort_day: "2026-03-02", cohort_size: 0, d1_retained: null, d7_retained: null });
    expect(points[7]).toEqual({ cohort_day: "2026-03-08", cohort_size: 50, d1_retained: 20, d7_retained: null });
    expect(points[9]).toEqual({ cohort_day: "2026-03-10", cohort_size: 30, d1_retained: null, d7_retained: null });
  });
});

describe("overview", () => {
  it("counts players in open sessions on live servers only, each player once", async () => {
    await env.pool.query(
      `INSERT INTO game_servers (game_id, server_id, last_seen_at) VALUES
         ($1, 'live', $2::timestamptz - interval '1 minute'),
         ($1, 'crashed', $2::timestamptz - interval '20 minutes')`,
      [GAME_ID, NOW],
    );
    await env.pool.query(
      `INSERT INTO player_sessions (game_id, server_id, player_id, joined_at, left_at) VALUES
         ($1, 'live', 1, $2::timestamptz - interval '10 minutes', NULL),
         ($1, 'live', 1, $2::timestamptz - interval '5 minutes', NULL),  -- duplicate join, same player
         ($1, 'live', 2, $2::timestamptz - interval '9 minutes', NULL),
         ($1, 'live', 3, $2::timestamptz - interval '9 minutes', $2::timestamptz - interval '2 minutes'),
         ($1, 'crashed', 4, $2::timestamptz - interval '30 minutes', NULL)`,
      [GAME_ID, NOW],
    );
    await env.pool.query(
      `INSERT INTO daily_active_users (game_id, day, users) VALUES ($1, '2026-03-10', 7), ($1, '2026-03-09', 99)`,
      [GAME_ID],
    );
    await env.pool.query(
      `INSERT INTO revenue_daily (game_id, day, robux, purchases) VALUES ($1, '2026-03-10', 450, 3)`,
      [GAME_ID],
    );

    const res = await env.build().inject(`/api/games/${GAME_ID}/overview`);
    expect(res.json()).toEqual({
      online_now: 2,
      servers_online: 1,
      dau_today: 7,
      robux_today: 450,
      purchases_today: 3,
      as_of: NOW.getTime(),
    } satisfies Overview);
  });

  it("reflects what the worker stored (the real write path, not hand-made rollup rows)", async () => {
    const t = NOW.getTime() - 60_000;
    const join = makeEvent({ player_id: 42, timestamp: t, received_at: t });
    const buy = makeEvent({
      player_id: 42,
      type: "purchase",
      timestamp: t + 1000,
      received_at: t + 1000,
      properties: { product_id: "sword", robux: 75 },
    });
    // Stored twice, as a redelivery would: still counted once.
    await storeEvents(env.pool, [join, buy]);
    await storeEvents(env.pool, [join, buy]);

    const body = (await env.build().inject(`/api/games/${GAME_ID}/overview`)).json() as Overview;
    expect(body).toMatchObject({ online_now: 1, servers_online: 1, dau_today: 1, robux_today: 75, purchases_today: 1 });
  });
});

describe("basic auth", () => {
  it("requires the password on every route except /health", async () => {
    const app = env.build({ config: { password: "correct-horse" } });
    const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`admin:${pw}`).toString("base64")}` });

    const missing = await app.inject("/api/games");
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe('Basic realm="Bloxlytics"');
    expect((await app.inject({ url: "/api/games", headers: basic("wrong-horse") })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/games", headers: basic("correct-horse") })).statusCode).toBe(200);
    expect((await app.inject("/health")).statusCode).toBe(200);
  });
});

describe("live stream", () => {
  async function listen(app: ReturnType<TestEnv["build"]>): Promise<string> {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  it("sends recent events on connect, then new events of this game only, plus overviews", async () => {
    const earlier = makeEvent({ type: "custom", name: "level_up", properties: { level: 2 } } as never);
    await enqueue(env.redis, earlier);
    const feed = await env.feed();
    const base = await listen(env.build({ feed }));

    const stream = await openStream(`${base}/api/games/${GAME_ID}/live`);
    expect(stream.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    try {
      const backfill = await stream.waitFor((m) => m.event === "game_event");
      expect((backfill.data as FeedEvent).event_id).toBe(earlier.event_id);
      await stream.waitFor((m) => m.event === "overview");

      const ours = makeEvent({ type: "purchase", properties: { product_id: 1, robux: 10 } });
      const theirs = makeEvent({ game_id: OTHER_GAME_ID });
      await enqueue(env.redis, theirs);
      await env.redis.xadd(STREAM, "*", STREAM_HEARTBEAT_FIELD, JSON.stringify({ game_id: GAME_ID }));
      await enqueue(env.redis, ours);

      const live = await stream.waitFor((m) => (m.data as FeedEvent).event_id === ours.event_id);
      expect(live.event).toBe("game_event");
      expect(live.data).toMatchObject({ type: "purchase", properties: { robux: 10 } });
      const ids = stream.messages.filter((m) => m.event === "game_event").map((m) => (m.data as FeedEvent).event_id);
      expect(ids).toEqual([earlier.event_id, ours.event_id]);
    } finally {
      stream.close();
    }
  });

  it("doesn't take entries from the workers' consumer group", async () => {
    await env.redis.xgroup("CREATE", STREAM, "bx-test-workers", "$", "MKSTREAM");
    const feed = await env.feed();
    const base = await listen(env.build({ feed }));
    const stream = await openStream(`${base}/api/games/${GAME_ID}/live`);
    try {
      const event = makeEvent();
      await enqueue(env.redis, event);
      await stream.waitFor((m) => (m.data as FeedEvent).event_id === event.event_id);
      // The group still has the entry to deliver, as if the dashboard weren't there.
      const groups = (await env.redis.xinfo("GROUPS", STREAM)) as unknown[][];
      const info = Object.fromEntries(
        Array.from({ length: groups[0]!.length / 2 }, (_, i) => [groups[0]![2 * i], groups[0]![2 * i + 1]]),
      );
      expect(info.pending).toBe(0);
      expect(info.lag).toBe(1);
    } finally {
      stream.close();
    }
  });

  it("ends open streams on shutdown instead of waiting on them forever", async () => {
    const feed = await env.feed();
    const app = env.build({ feed });
    const base = await listen(app);
    const stream = await openStream(`${base}/api/games/${GAME_ID}/live`);
    await stream.waitFor((m) => m.event === "overview");
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    stream.close();
  });

  it("404s the stream for an unknown game", async () => {
    const base = await listen(env.build());
    const res = await fetch(`${base}/api/games/nope/live`);
    expect(res.status).toBe(404);
  });
});
