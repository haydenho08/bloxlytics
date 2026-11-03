// Load generator: simulates N game servers x M players sending events to the
// ingestion API the way the Luau SDK does, steps through target rates, and
// reports throughput and latency for each.
//
//   npm run loadgen -- --servers 100 --players 20 --steps 1000,2000,4000 --step-seconds 30
//
// See packages/loadgen/README.md for every option.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { createPool, generateApiKey, hashApiKey, type Pool } from "@bloxlytics/db";
import { DEFAULT_EVENTS_STREAM, type GameEventInput } from "@bloxlytics/shared";
import { Redis } from "ioredis";
import { GameServerSim } from "./sim.ts";
import { percentile, Window } from "./stats.ts";

const gzip = promisify(gzipCb);

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8080" },
    game: { type: "string", default: "loadtest" },
    key: { type: "string" },
    servers: { type: "string", default: "50" },
    players: { type: "string", default: "20" },
    steps: { type: "string", default: "500,1000,2000" },
    "step-seconds": { type: "string", default: "30" },
    warmup: { type: "string", default: "5" },
    batch: { type: "string", default: "50" },
    "flush-ms": { type: "string", default: "10000" },
    gzip: { type: "boolean", default: true },
    "no-gzip": { type: "boolean", default: false },
    stream: { type: "string", default: DEFAULT_EVENTS_STREAM },
  },
});

const servers = Number(args.servers);
const players = Number(args.players);
const steps = args.steps.split(",").map(Number);
const stepSeconds = Number(args["step-seconds"]);
const warmupSeconds = Number(args.warmup);
const useGzip = args.gzip && !args["no-gzip"];
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (steps.some((s) => !(s > 0)) || !(servers > 0) || !(players > 0)) {
  console.error("--servers, --players and every --steps value must be positive numbers");
  process.exit(1);
}

// Optional connections, only for measuring: Postgres for how long events took
// to be stored, Redis for the backlog. The load itself goes through HTTP only.
const pool: Pool | undefined = databaseUrl ? createPool(databaseUrl, 2) : undefined;
const redis = redisUrl ? new Redis(redisUrl) : undefined;

/** Without --key, makes the game if needed and issues a key for this run (revoked at the end). */
async function obtainKey(): Promise<{ key: string; revoke: () => Promise<void> }> {
  if (args.key) return { key: args.key, revoke: async () => {} };
  if (!pool) throw new Error("Pass --key, or set DATABASE_URL so a key can be issued for the run");
  await pool.query("INSERT INTO games (id, name) VALUES ($1, 'Load test') ON CONFLICT (id) DO NOTHING", [args.game]);
  const key = generateApiKey();
  await pool.query("INSERT INTO api_keys (game_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
    args.game,
    hashApiKey(key),
    key.slice(0, 10),
  ]);
  return {
    key,
    revoke: async () => {
      await pool.query("UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1", [hashApiKey(key)]);
    },
  };
}

const { key, revoke } = await obtainKey();
const sims = Array.from(
  { length: servers },
  (_, i) =>
    new GameServerSim({
      gameId: args.game,
      serverId: `loadgen-${process.pid}-${i}`,
      players,
      eventsPerPlayerSec: 0,
      batchSize: Number(args.batch),
      flushMs: Number(args["flush-ms"]),
    }),
);
const cooldownUntil = new Map<GameServerSim, number>();
let window = new Window();

async function send(sim: GameServerSim, batch: GameEventInput[]): Promise<void> {
  sim.inFlight = true;
  const json = JSON.stringify({ events: batch });
  const body = useGzip ? await gzip(json) : json;
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key };
  if (useGzip) headers["content-encoding"] = "gzip";
  const target = window;
  const started = performance.now();
  try {
    const res = await fetch(`${args.url}/v1/events`, { method: "POST", headers, body });
    await res.arrayBuffer();
    target.record(res.status, batch.length, performance.now() - started);
    if (res.status !== 202) {
      // Like the SDK: keep the batch and back off. 4xx other than 429 would be a loadgen bug.
      sim.putBack(batch);
      cooldownUntil.set(sim, Date.now() + 1000);
      if (res.status !== 429 && res.status !== 503) console.error(`HTTP ${res.status}`);
    }
  } catch {
    target.record(0, batch.length, performance.now() - started);
    sim.putBack(batch);
    cooldownUntil.set(sim, Date.now() + 1000);
  } finally {
    sim.inFlight = false;
  }
}

// The clock that drives every simulated server.
let last = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  const elapsed = now - last;
  last = now;
  for (const sim of sims) {
    sim.generate(elapsed);
    if ((cooldownUntil.get(sim) ?? 0) > now) continue;
    const batch = sim.takeBatch(now);
    if (batch) void send(sim, batch);
  }
}, 20);

async function streamBacklog(): Promise<number | undefined> {
  return redis ? redis.xlen(args.stream) : undefined;
}

interface StepResult {
  target: number;
  window: Window;
  seconds: number;
  from: Date;
  to: Date;
  clientBacklog: number;
  streamBacklogAtStart: number | undefined;
  streamBacklog: number | undefined;
  loopDelayP99: number;
}

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const results: StepResult[] = [];

console.log(
  `${servers} servers x ${players} players -> ${args.url} (${useGzip ? "gzip" : "plain"} bodies, ` +
    `batch ${args.batch}, flush ${args["flush-ms"]}ms)\n`,
);

for (const target of steps) {
  const perPlayer = target / (servers * players);
  for (const sim of sims) sim.setRate(perPlayer);
  process.stdout.write(`step ${target} ev/s: warming up ${warmupSeconds}s, measuring ${stepSeconds}s... `);
  await sleep(warmupSeconds * 1000);

  window = new Window();
  loopDelay.reset();
  const from = new Date();
  const backlogAtStart = await streamBacklog();
  await sleep(stepSeconds * 1000);
  const to = new Date();
  const measured = window;
  // Requests sent from now on (the next step's warm-up) must not count towards this step.
  window = new Window();
  const result: StepResult = {
    target,
    window: measured,
    seconds: measured.seconds(to.getTime()),
    from,
    to,
    clientBacklog: sims.reduce((n, s) => n + s.buffered, 0),
    streamBacklogAtStart: backlogAtStart,
    streamBacklog: await streamBacklog(),
    loopDelayP99: loopDelay.percentile(99) / 1e6,
  };
  results.push(result);
  console.log(`${Math.round(measured.accepted / result.seconds)} ev/s accepted`);
}

clearInterval(ticker);
for (const sim of sims) sim.setRate(0);

// Let the workers catch up before asking Postgres how long storing took, so
// events still queued count with their real (long) delay instead of being missed.
// Gives up if the backlog stops shrinking (no worker running) or after 2 minutes.
if (redis) {
  const deadline = Date.now() + 120_000;
  let backlog = (await streamBacklog()) ?? 0;
  let lastProgress = Date.now();
  while (backlog > 0 && Date.now() < deadline && Date.now() - lastProgress < 10_000) {
    await sleep(500);
    const now = (await streamBacklog()) ?? 0;
    if (now < backlog) lastProgress = Date.now();
    backlog = now;
  }
}

interface PipelineLag {
  stored: number;
  p50: number | null;
  p95: number | null;
}

async function pipelineLag(from: Date, to: Date): Promise<PipelineLag | undefined> {
  if (!pool) return undefined;
  const { rows } = await pool.query<{ stored: string; p50: number | null; p95: number | null }>(
    `SELECT count(*) AS stored,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM stored_at - received_at) * 1000) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM stored_at - received_at) * 1000) AS p95
     FROM events WHERE game_id = $1 AND received_at >= $2 AND received_at < $3`,
    [args.game, from, to],
  );
  const row = rows[0]!;
  return { stored: Number(row.stored), p50: row.p50, p95: row.p95 };
}

const fmt = (n: number | null | undefined, digits = 0) => (n == null || Number.isNaN(n) ? "-" : n.toFixed(digits));

console.log(
  "\n| target ev/s | accepted ev/s | req/s | p50 ms | p95 ms | p99 ms | 429/503/err | stream backlog start → end | store lag p50/p95 ms | sustained |",
);
console.log("|---:|---:|---:|---:|---:|---:|:---:|---:|:---:|:---:|");
for (const r of results) {
  const w = r.window;
  const accepted = w.accepted / r.seconds;
  const lag = await pipelineLag(r.from, r.to);
  // Sustained: the API took (nearly) everything offered, nothing piled up on the
  // simulated servers beyond one partial batch each, and the workers kept up:
  // the stream grew by less than 2% of what was added during the step.
  const growth =
    r.streamBacklog === undefined || r.streamBacklogAtStart === undefined ? 0 : r.streamBacklog - r.streamBacklogAtStart;
  const sustained =
    accepted >= r.target * 0.97 &&
    r.clientBacklog <= servers * Number(args.batch) &&
    growth <= w.accepted * 0.02;
  console.log(
    `| ${r.target} | ${fmt(accepted)} | ${fmt(w.requests / r.seconds)} | ${fmt(percentile(w.latencies, 50), 1)} | ` +
      `${fmt(percentile(w.latencies, 95), 1)} | ${fmt(percentile(w.latencies, 99), 1)} | ` +
      `${w.rateLimited}/${w.overloaded}/${w.failed} | ${fmt(r.streamBacklogAtStart)} → ${fmt(r.streamBacklog)} | ` +
      `${lag ? `${fmt(lag.p50)}/${fmt(lag.p95)}` : "-"} | ${sustained ? "yes" : "no"} |`,
  );
}
const worstLoop = Math.max(...results.map((r) => r.loopDelayP99));
console.log(
  `\nloadgen event loop delay p99: ${worstLoop.toFixed(1)}ms` +
    (worstLoop > 50 ? " (high: the load generator itself is busy, so latencies above are inflated)" : ""),
);

await revoke();
await pool?.end();
redis?.disconnect();
