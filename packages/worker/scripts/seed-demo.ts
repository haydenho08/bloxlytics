// Fills a game with a couple of weeks of made-up history, so the dashboard has
// something to show before a real game has been sending events for weeks.
//
//   npm run seed-demo -- <game-id> [days]
//
// It doesn't write rollup rows by hand. It makes ordinary events and stores them
// with the worker's own storeEvents, then runs the rollup job once, so the
// dashboard shows exactly what the real pipeline would have produced.
//
// The randomness is seeded from the game id, so event_ids come out the same every
// run. Running it twice is harmless: the second run's events are all duplicates,
// and ON CONFLICT DO NOTHING skips them (the same idempotency that protects
// redeliveries).
import { createHash } from "node:crypto";
import { createGame, createPool } from "@bloxlytics/db";
import { GAME_ID_PATTERN, type StreamEvent } from "@bloxlytics/shared";
import { refreshRollups } from "../src/rollups.ts";
import { storeEvents } from "../src/store.ts";

const [gameId, daysArg] = process.argv.slice(2);
const days = Number(daysArg ?? 14);
if (!gameId || !GAME_ID_PATTERN.test(gameId) || !Number.isInteger(days) || days < 1 || days > 30) {
  console.error("Usage: npm run seed-demo -- <game-id> [days, 1-30, default 14]");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (see .env.example).");
  process.exit(1);
}

/** mulberry32: a tiny seeded PRNG. Same seed, same sequence. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(createHash("sha256").update(gameId).digest().readUInt32LE(0));
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

function uuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

// More players in the (UTC) evening than at 5am, like a real game.
const HOUR_WEIGHTS = [3, 2, 2, 1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 12, 11, 9, 7, 5];
const HOUR_TOTAL = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
function randomHour(): number {
  let r = rand() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) if ((r -= HOUR_WEIGHTS[h]!) < 0) return h;
  return 23;
}

const PRODUCTS = [
  { product_id: "speed_coil", robux: 25 },
  { product_id: "double_jump", robux: 50 },
  { product_id: "vip_pass", robux: 400 },
  { product_id: "coin_pack_small", robux: 75 },
  { product_id: "pet_egg", robux: 100 },
] as const;
const SERVERS = ["demo-server-1", "demo-server-2", "demo-server-3", "demo-server-4"];
const DAY_MS = 86_400_000;

const now = Date.now();
// Only the past: no sessions still open, so "online now" shows real traffic only.
const cutoff = now - 2 * 60_000;
const firstDay = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;

const events: StreamEvent[] = [];
const players: { id: number; firstDay: number }[] = [];
let nextPlayerId = 9_000_000_001; // Well away from real Roblox UserIds.

function event(type: StreamEvent["type"], playerId: number, server: string, at: number, extra: object = {}): void {
  const t = Math.round(at); // Epoch ms are integers, as from the SDK.
  const e = { event_id: uuid(), game_id: gameId!, server_id: server, player_id: playerId, type, timestamp: t, received_at: t, properties: {}, ...extra };
  if (t < cutoff) events.push(e as StreamEvent);
}

for (let day = firstDay; day <= now; day += DAY_MS) {
  const dayIndex = (day - firstDay) / DAY_MS;
  // New players: 30-60 a day, a few more at the weekend, slowly growing.
  const weekend = [0, 6].includes(new Date(day).getUTCDay());
  const newToday = Math.round(between(30, 60) * (weekend ? 1.3 : 1) * (1 + dayIndex * 0.02));
  for (let i = 0; i < newToday; i++) players.push({ id: nextPlayerId++, firstDay: day });

  for (const player of players) {
    const age = (day - player.firstDay) / DAY_MS;
    // Everyone plays on their first day; after that, the chance of coming back
    // falls off with age (about 40% on day 1, 15% by day 7).
    const plays = age === 0 || rand() < Math.max(0.04, 0.42 * Math.pow(age, -0.55));
    if (!plays) continue;

    let start = day + randomHour() * 3_600_000 + rand() * 3_600_000;
    const sessions = rand() < 0.3 ? 2 : 1;
    for (let s = 0; s < sessions; s++) {
      const end = start + between(4, 45) * 60_000;
      if (end >= cutoff) break; // Would still be in progress: leave it out entirely.
      const server = pick(SERVERS);
      event("player_join", player.id, server, start);
      if (rand() < 0.6) {
        event("custom", player.id, server, between(start, end), { name: "level_up", properties: { level: Math.ceil(between(1, 30)) } });
      }
      if (rand() < 0.12) {
        event("purchase", player.id, server, between(start, end), { properties: { ...pick(PRODUCTS) } });
      }
      event("player_leave", player.id, server, end);
      start = end + between(30, 240) * 60_000;
    }
  }
}

events.sort((a, b) => a.timestamp - b.timestamp);

const pool = createPool(url, 2);
try {
  const exists = await pool.query("SELECT 1 FROM games WHERE id = $1", [gameId]);
  if (exists.rowCount === 0) {
    const { apiKey } = await createGame(pool, gameId, "Demo Game");
    console.log(`Created game "${gameId}". API key (shown once):\n\n  ${apiKey}\n`);
  }

  let added = 0;
  for (let i = 0; i < events.length; i += 1000) {
    added += await storeEvents(pool, events.slice(i, i + 1000));
  }
  console.log(`${events.length} events generated over ${days} days, ${added} new (the rest were already stored).`);

  // The worker's job only looks back an hour for players online; widen it once
  // so the 24h chart is filled in too.
  await refreshRollups(pool, { onlineWindowMinutes: 24 * 60, serverStaleAfterMs: 5 * 60_000 });
  console.log("Rollups refreshed. Open the dashboard and pick the game.");
} finally {
  await pool.end();
}
