import { gzipSync } from "node:zlib";
import { STREAM_EVENT_FIELD, STREAM_HEARTBEAT_FIELD, type StreamEvent } from "@gamepulse/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRedis } from "../src/redis.ts";
import { createTestEnv, GAME_ID, makeBatch, makeEvent, OTHER_GAME_ID, type TestEnv } from "./helpers.ts";

const STREAM = "gp:test:events";
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

function post(app: ReturnType<TestEnv["build"]>, body: unknown, apiKey: string | null = env.apiKey) {
  return app.inject({
    method: "POST",
    url: "/v1/events",
    headers: apiKey ? { "x-api-key": apiKey } : {},
    payload: body as object,
  });
}

async function readStream(): Promise<StreamEvent[]> {
  const entries = await env.redis.xrange(STREAM, "-", "+");
  return entries.map(([, fields]) => {
    const i = fields.indexOf(STREAM_EVENT_FIELD);
    return JSON.parse(fields[i + 1]!) as StreamEvent;
  });
}

describe("POST /v1/events: happy path", () => {
  it("accepts a valid batch with 202 and puts each event on the stream", async () => {
    const app = env.build();
    const batch = {
      events: [
        makeEvent({ type: "player_join" }),
        makeEvent({ type: "purchase", properties: { product_id: 123, robux: 50, extra: "kept" } }),
        makeEvent({ type: "custom", name: "level_complete", properties: { level: 3 } }),
        makeEvent({ type: "player_leave" }),
      ],
    };

    const res = await post(app, batch);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 4 });
    const onStream = await readStream();
    expect(onStream.map((e) => e.type)).toEqual(["player_join", "purchase", "custom", "player_leave"]);
    // Normalised (GUID lower-cased) and stamped with our receive time.
    expect(onStream[0]!.event_id).toBe(batch.events[0]!.event_id.toLowerCase());
    expect(onStream[0]!.received_at).toBeTypeOf("number");
    expect(onStream[1]!.properties).toEqual({ product_id: 123, robux: 50, extra: "kept" });
  });

  it("accepts exactly 100 events", async () => {
    const res = await post(env.build(), makeBatch(100));
    expect(res.statusCode).toBe(202);
    expect(await env.redis.xlen(STREAM)).toBe(100);
  });

  it("echoes a caller-supplied request id", async () => {
    const res = await env.build().inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": env.apiKey, "x-request-id": "abc-123" },
      payload: makeBatch(1),
    });
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });
});

describe("POST /v1/events: authentication", () => {
  it("rejects a missing key with 401", async () => {
    const res = await post(env.build(), makeBatch(1), null);
    expect(res.statusCode).toBe(401);
  });

  it("rejects a well-formed but unknown key with 401", async () => {
    const res = await post(env.build(), makeBatch(1), "gp_" + "A".repeat(43));
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key once the cache entry expires", async () => {
    const app = env.build({ auth: { validTtlMs: 0 } });
    expect((await post(app, makeBatch(1))).statusCode).toBe(202);

    await env.pool.query("UPDATE api_keys SET revoked_at = now() WHERE game_id = $1", [GAME_ID]);

    expect((await post(app, makeBatch(1))).statusCode).toBe(401);
  });

  it("never stores the plaintext key", async () => {
    const { rows } = await env.pool.query("SELECT key_hash, key_prefix FROM api_keys WHERE game_id = $1", [GAME_ID]);
    expect(rows[0].key_hash).not.toContain(env.apiKey);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.apiKey.startsWith(rows[0].key_prefix)).toBe(true);
  });

  it("rejects events for a different game with 403", async () => {
    const batch = { events: [makeEvent(), makeEvent({ game_id: OTHER_GAME_ID })] };
    const res = await post(env.build(), batch);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "game_id_mismatch", indexes: [1] });
    expect(await env.redis.xlen(STREAM)).toBe(0);
  });
});

describe("POST /v1/events: validation", () => {
  it.each([
    ["an empty batch", { events: [] }],
    ["101 events", makeBatch(101)],
    ["no events array", { foo: 1 }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await post(env.build(), body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_batch");
  });

  it("rejects the whole batch if one event is bad, and says which one", async () => {
    const batch = { events: [makeEvent(), makeEvent({ event_id: "not-a-guid" }), makeEvent()] };
    const res = await post(env.build(), batch);
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("events.1.event_id");
    expect(await env.redis.xlen(STREAM)).toBe(0);
  });

  it("rejects a purchase without robux", async () => {
    const res = await post(env.build(), {
      events: [makeEvent({ type: "purchase", properties: { product_id: "sword" } as never })],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("events.0.properties.robux");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await env.build().inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": env.apiKey, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/events: rate limiting", () => {
  it("returns 429 with Retry-After once a game's bucket is empty", async () => {
    const app = env.build({ config: { rateLimit: { eventsPerSec: 10, burst: 100 } } });

    expect((await post(app, makeBatch(100))).statusCode).toBe(202);
    const res = await post(app, makeBatch(20));

    expect(res.statusCode).toBe(429);
    // 20 tokens at 10/sec is ~2s to refill.
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(res.json().error).toBe("rate_limited");
  });

  it("keeps a separate bucket per game", async () => {
    const app = env.build({ config: { rateLimit: { eventsPerSec: 10, burst: 100 } } });
    expect((await post(app, makeBatch(100))).statusCode).toBe(202);

    const other = makeBatch(50, { game_id: OTHER_GAME_ID });
    expect((await post(app, other, env.otherApiKey)).statusCode).toBe(202);
  });

  it("is shared across API instances, because the bucket lives in Redis", async () => {
    const config = { rateLimit: { eventsPerSec: 10, burst: 100 } };
    const a = env.build({ config });
    const b = env.build({ config });
    expect((await post(a, makeBatch(100))).statusCode).toBe(202);
    expect((await post(b, makeBatch(1))).statusCode).toBe(429);
  });
});

describe("POST /v1/events: backpressure and failures", () => {
  it("sheds load with 503 when the stream is too far behind, without a partial write", async () => {
    const app = env.build({ config: { stream: { name: STREAM, maxPending: 150 } } });
    expect((await post(app, makeBatch(100))).statusCode).toBe(202);

    const res = await post(app, makeBatch(100));

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("queue_full");
    expect(await env.redis.xlen(STREAM)).toBe(100);
  });

  it("answers 503 quickly when Redis is unreachable", async () => {
    const deadRedis = createRedis("redis://127.0.0.1:1");
    deadRedis.on("error", () => {}); // expected: nothing is listening there
    const app = env.build({ redis: deadRedis });

    const started = Date.now();
    const res = await post(app, makeBatch(1));

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("redis_unavailable");
    expect(Date.now() - started).toBeLessThan(1000);
    deadRedis.disconnect();
  });
});

describe("health", () => {
  it("/health is always ok", async () => {
    const res = await env.build().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("/ready checks Redis and Postgres", async () => {
    const res = await env.build().inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ redis: "ok", postgres: "ok" });
  });

  it("/ready fails when Redis is down", async () => {
    const deadRedis = createRedis("redis://127.0.0.1:1");
    deadRedis.on("error", () => {});
    const res = await env.build({ redis: deadRedis }).inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis).toBe("error");
    deadRedis.disconnect();
  });
});

describe("gzip request bodies", () => {
  function postGzip(app: ReturnType<TestEnv["build"]>, body: Buffer, encoding = "gzip") {
    return app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-api-key": env.apiKey, "content-type": "application/json", "content-encoding": encoding },
      payload: body,
    });
  }

  it("accepts a gzip-compressed batch", async () => {
    const batch = makeBatch(50);
    const compressed = gzipSync(JSON.stringify(batch));
    const res = await postGzip(env.build(), compressed);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 50 });
    expect(compressed.length).toBeLessThan(JSON.stringify(batch).length / 2);
  });

  it("rejects a body that decompresses past the size limit with 413", async () => {
    // ~5 KB of gzip that expands to 20 MB: a zip bomb.
    const bomb = gzipSync(`{"events":[],"pad":"${"x".repeat(20 * 1024 * 1024)}"}`);
    const res = await postGzip(env.build(), bomb);
    expect(res.statusCode).toBe(413);
    expect(await env.redis.xlen(STREAM)).toBe(0);
  });

  it("rejects corrupt gzip with 400 and unknown encodings with 415", async () => {
    expect((await postGzip(env.build(), Buffer.from("definitely not gzip"))).statusCode).toBe(400);
    expect((await postGzip(env.build(), Buffer.from("{}"), "br")).statusCode).toBe(415);
  });
});

describe("POST /v1/heartbeat", () => {
  function heartbeat(app: ReturnType<TestEnv["build"]>, body: object, apiKey = env.apiKey) {
    return app.inject({ method: "POST", url: "/v1/heartbeat", headers: { "x-api-key": apiKey }, payload: body });
  }

  it("puts a heartbeat entry on the stream", async () => {
    const res = await heartbeat(env.build(), { game_id: GAME_ID, server_id: "server-1", players: 3 });
    expect(res.statusCode).toBe(202);
    const entries = await env.redis.xrange(STREAM, "-", "+");
    const fields = entries[0]![1];
    expect(fields[0]).toBe(STREAM_HEARTBEAT_FIELD);
    expect(JSON.parse(fields[1]!)).toMatchObject({ game_id: GAME_ID, server_id: "server-1", players: 3 });
  });

  it("checks the key, the body and the game", async () => {
    const app = env.build();
    const ok = { game_id: GAME_ID, server_id: "server-1", players: 0 };
    expect((await heartbeat(app, ok, "gp_" + "A".repeat(43))).statusCode).toBe(401);
    expect((await heartbeat(app, { game_id: GAME_ID })).statusCode).toBe(400);
    expect((await heartbeat(app, { ...ok, game_id: OTHER_GAME_ID })).statusCode).toBe(403);
    expect(await env.redis.xlen(STREAM)).toBe(0);
  });
});
