import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refreshRollups } from "../src/rollups.ts";
import { storeEvents } from "../src/store.ts";
import { count, createTestEnv, makeEvent, type TestEnv } from "./helpers.ts";

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

const ROLLUPS = { onlineWindowMinutes: 60, serverStaleAfterMs: 5 * 60_000 };
const at = (iso: string) => Date.parse(iso);

/** An event that happened (and reached us) at the given time. */
function eventAt(iso: string, overrides: Parameters<typeof makeEvent>[0] = {}) {
  return makeEvent({ timestamp: at(iso), received_at: at(iso), ...overrides });
}

describe("write-time rollups", () => {
  it("counts each player once per UTC day for DAU", async () => {
    await storeEvents(env.pool, [
      eventAt("2026-01-10T08:00:00Z", { player_id: 1 }),
      eventAt("2026-01-10T09:00:00Z", { player_id: 1, type: "custom", name: "jump" }),
      eventAt("2026-01-10T23:59:59Z", { player_id: 2 }),
    ]);
    // A later batch with someone already counted, and the next UTC day.
    await storeEvents(env.pool, [
      eventAt("2026-01-10T12:00:00Z", { player_id: 2 }),
      eventAt("2026-01-11T00:00:00Z", { player_id: 1 }),
    ]);

    const { rows } = await env.pool.query("SELECT day::text, users FROM daily_active_users ORDER BY day");
    expect(rows).toEqual([
      { day: "2026-01-10", users: 2 },
      { day: "2026-01-11", users: 1 },
    ]);
  });

  it("sums purchase revenue per day", async () => {
    await storeEvents(env.pool, [
      eventAt("2026-01-10T08:00:00Z", { type: "purchase", properties: { product_id: 1, robux: 40 } }),
      eventAt("2026-01-10T09:00:00Z", { type: "purchase", properties: { product_id: 2, robux: 60 } }),
      eventAt("2026-01-11T09:00:00Z", { type: "purchase", properties: { product_id: 2, robux: 5 } }),
    ]);
    const { rows } = await env.pool.query(
      "SELECT day::text, robux::int, purchases FROM revenue_daily ORDER BY day",
    );
    expect(rows).toEqual([
      { day: "2026-01-10", robux: 100, purchases: 2 },
      { day: "2026-01-11", robux: 5, purchases: 1 },
    ]);
  });

  it("pairs joins with leaves into sessions, even across batches", async () => {
    await storeEvents(env.pool, [eventAt("2026-01-10T08:00:00Z", { player_id: 1 })]);
    await storeEvents(env.pool, [
      eventAt("2026-01-10T08:30:00Z", { player_id: 1, type: "player_leave" }),
      // Rejoins the same server, then leaves again, all in one batch.
      eventAt("2026-01-10T09:00:00Z", { player_id: 1 }),
      eventAt("2026-01-10T09:10:00Z", { player_id: 1, type: "player_leave" }),
    ]);
    const { rows } = await env.pool.query(
      "SELECT to_char(joined_at AT TIME ZONE 'UTC', 'HH24:MI') AS joined, to_char(left_at AT TIME ZONE 'UTC', 'HH24:MI') AS left FROM player_sessions ORDER BY joined_at",
    );
    expect(rows).toEqual([
      { joined: "08:00", left: "08:30" },
      { joined: "09:00", left: "09:10" },
    ]);
  });
});

describe("players online per minute", () => {
  const now = new Date("2026-01-20T12:00:30Z");

  async function onlineAt(minute: string): Promise<number> {
    return count(env.pool, "SELECT coalesce(sum(players), 0) FROM players_online_minute WHERE minute = $1", [
      minute,
    ]);
  }

  it("counts players between join and leave, and ends sessions on servers that went quiet", async () => {
    await storeEvents(env.pool, [
      eventAt("2026-01-20T11:50:00Z", { player_id: 1 }),
      eventAt("2026-01-20T11:50:00Z", { player_id: 2 }),
      eventAt("2026-01-20T11:55:00Z", { player_id: 2, type: "player_leave" }),
      // The server is still sending events, so player 1 is still online.
      eventAt("2026-01-20T12:00:00Z", { player_id: 1, type: "custom", name: "tick" }),
      // server-2 crashed at 11:51: no player_leave will ever come for player 3.
      eventAt("2026-01-20T11:50:00Z", { player_id: 3, server_id: "server-2" }),
      eventAt("2026-01-20T11:51:00Z", { player_id: 4, server_id: "server-2", type: "custom", name: "tick" }),
    ]);

    expect(await refreshRollups(env.pool, ROLLUPS, now)).toBe(true);

    expect(await onlineAt("2026-01-20T11:49:00Z")).toBe(0);
    expect(await onlineAt("2026-01-20T11:50:00Z")).toBe(3);
    expect(await onlineAt("2026-01-20T11:51:00Z")).toBe(2);
    expect(await onlineAt("2026-01-20T11:54:00Z")).toBe(2);
    expect(await onlineAt("2026-01-20T11:55:00Z")).toBe(1);
    expect(await onlineAt("2026-01-20T12:00:00Z")).toBe(1);
  });

  it("replaces the window on every run, so a minute can drop back to zero", async () => {
    await storeEvents(env.pool, [eventAt("2026-01-20T11:50:00Z", { player_id: 1, received_at: now.getTime() })]);
    await refreshRollups(env.pool, ROLLUPS, now);
    expect(await onlineAt("2026-01-20T11:59:00Z")).toBe(1);

    // A late player_leave arrives: they actually left at 11:52.
    await storeEvents(env.pool, [
      eventAt("2026-01-20T11:52:00Z", { player_id: 1, type: "player_leave", received_at: now.getTime() }),
    ]);
    await refreshRollups(env.pool, ROLLUPS, now);
    await refreshRollups(env.pool, ROLLUPS, now); // and running it twice changes nothing
    expect(await onlineAt("2026-01-20T11:51:00Z")).toBe(1);
    expect(await onlineAt("2026-01-20T11:59:00Z")).toBe(0);
  });
});

describe("retention", () => {
  const now = new Date("2026-01-20T12:00:00Z");

  async function cohorts() {
    const { rows } = await env.pool.query(
      "SELECT cohort_day::text AS day, cohort_size AS size, d1_retained AS d1, d7_retained AS d7 FROM retention_daily ORDER BY cohort_day",
    );
    return rows;
  }

  it("computes day-1 and day-7 retention per first-seen cohort", async () => {
    await storeEvents(env.pool, [
      // Cohort Jan 10: players 1 and 2.
      eventAt("2026-01-10T10:00:00Z", { player_id: 1 }),
      eventAt("2026-01-10T11:00:00Z", { player_id: 2 }),
      eventAt("2026-01-11T10:00:00Z", { player_id: 1 }), // day 1: only player 1
      eventAt("2026-01-17T10:00:00Z", { player_id: 1 }), // day 7: both
      eventAt("2026-01-17T10:00:00Z", { player_id: 2 }),
      // Cohort Jan 19: day 1 (Jan 20) isn't over yet, so no number yet.
      eventAt("2026-01-19T10:00:00Z", { player_id: 3 }),
    ]);

    await refreshRollups(env.pool, ROLLUPS, now);

    expect(await cohorts()).toEqual([
      { day: "2026-01-10", size: 2, d1: 1, d7: 2 },
      { day: "2026-01-19", size: 1, d1: null, d7: null },
    ]);
  });

  it("moves a player to an earlier cohort when a late event shows they were here before", async () => {
    await storeEvents(env.pool, [
      eventAt("2026-01-10T10:00:00Z", { player_id: 1 }),
      eventAt("2026-01-10T10:00:00Z", { player_id: 2 }),
    ]);
    await refreshRollups(env.pool, ROLLUPS, now);
    expect((await cohorts())[0]).toMatchObject({ day: "2026-01-10", size: 2 });

    // The SDK retried a batch from two days earlier: player 1 was first seen on Jan 8.
    await storeEvents(env.pool, [eventAt("2026-01-08T10:00:00Z", { player_id: 1 })]);
    await refreshRollups(env.pool, ROLLUPS, now);

    expect(await cohorts()).toEqual([
      { day: "2026-01-08", size: 1, d1: 0, d7: 0 },
      { day: "2026-01-10", size: 1, d1: 0, d7: 0 },
    ]);
  });
});

describe("refresh job", () => {
  it("skips its turn while another worker holds the lock", async () => {
    const other = await env.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(727002)");
      expect(await refreshRollups(env.pool, ROLLUPS)).toBe(false);
      await other.query("ROLLBACK");
      expect(await refreshRollups(env.pool, ROLLUPS)).toBe(true);
    } finally {
      other.release();
    }
  });
});
