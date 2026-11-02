import type { Pool, PoolClient } from "pg";
import type { StreamEvent } from "@gamepulse/shared";

/**
 * Stores a batch of events and updates the write-time rollups, all in one
 * transaction. Returns how many events were new.
 *
 * Idempotent: storing the same events again changes nothing. The raw insert
 * skips event_ids already in the table, and every rollup below is driven only by
 * the rows that insert actually added. So a redelivered event adds no row and
 * therefore can't be counted twice.
 *
 * Every multi-row upsert is sorted by its key. Two workers upserting the same
 * rows in different orders could each lock one and wait for the other forever
 * (a deadlock); sorting means they always queue up in the same order instead.
 */
export async function storeEvents(pool: Pool, events: readonly StreamEvent[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newIds = await insertRawEvents(client, events);
    if (newIds.length > 0) await updateRollups(client, newIds);
    await client.query("COMMIT");
    return newIds.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Inserts the batch in one statement and returns the event_ids that weren't there yet. */
async function insertRawEvents(client: PoolClient, events: readonly StreamEvent[]): Promise<string[]> {
  // The whole batch goes over as one JSON parameter and is unpacked into rows by
  // Postgres: one round trip however big the batch is.
  const { rows } = await client.query<{ event_id: string }>(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         event_id uuid, game_id text, server_id text, player_id bigint, type text,
         name text, "timestamp" bigint, received_at bigint, properties jsonb)
     )
     INSERT INTO events (event_id, game_id, server_id, player_id, type, name, occurred_at, received_at, properties)
     SELECT event_id, game_id, server_id, player_id, type, name,
            to_timestamp("timestamp" / 1000.0), to_timestamp(received_at / 1000.0), properties
     FROM input
     ORDER BY event_id
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [JSON.stringify(events)],
  );
  return rows.map((r) => r.event_id);
}

// Each statement reads just-inserted rows back by primary key, so the rollup SQL
// works on real columns (occurred_at, the UTC day) instead of re-deriving them in JS.
const NEW_EVENTS = "SELECT * FROM events WHERE event_id = ANY($1::uuid[])";
const UTC_DAY = "(occurred_at AT TIME ZONE 'UTC')::date";

async function updateRollups(client: PoolClient, newIds: string[]): Promise<void> {
  // When each server last talked to us (our clock, not the game's). Used to
  // spot servers that crashed without sending player_leave.
  await client.query(
    `INSERT INTO game_servers (game_id, server_id, last_seen_at)
     SELECT game_id, server_id, max(received_at) FROM (${NEW_EVENTS}) e
     GROUP BY 1, 2 ORDER BY 1, 2
     ON CONFLICT (game_id, server_id) DO UPDATE
       SET last_seen_at = GREATEST(game_servers.last_seen_at, EXCLUDED.last_seen_at)`,
    [newIds],
  );

  // A player's cohort is their first day. Events arrive late and out of order,
  // so "first" can move earlier; the WHERE skips rewriting rows that don't change.
  await client.query(
    `INSERT INTO players (game_id, player_id, first_seen_at)
     SELECT game_id, player_id, min(occurred_at) FROM (${NEW_EVENTS}) e
     GROUP BY 1, 2 ORDER BY 1, 2
     ON CONFLICT (game_id, player_id) DO UPDATE
       SET first_seen_at = EXCLUDED.first_seen_at
       WHERE EXCLUDED.first_seen_at < players.first_seen_at`,
    [newIds],
  );

  // DAU is a count of *distinct* players, so it can't just be incremented per
  // event. player_days remembers who was already counted; only the rows it
  // newly accepts add to the day's total.
  await client.query(
    `WITH new_days AS (
       INSERT INTO player_days (game_id, player_id, day)
       SELECT DISTINCT game_id, player_id, ${UTC_DAY} FROM (${NEW_EVENTS}) e
       ORDER BY 1, 2, 3
       ON CONFLICT DO NOTHING
       RETURNING game_id, day
     )
     INSERT INTO daily_active_users (game_id, day, users)
     SELECT game_id, day, count(*) FROM new_days
     GROUP BY 1, 2 ORDER BY 1, 2
     ON CONFLICT (game_id, day) DO UPDATE
       SET users = daily_active_users.users + EXCLUDED.users`,
    [newIds],
  );

  await client.query(
    `INSERT INTO revenue_daily (game_id, day, robux, purchases)
     SELECT game_id, ${UTC_DAY}, sum((properties->>'robux')::bigint), count(*)
     FROM (${NEW_EVENTS}) e WHERE type = 'purchase'
     GROUP BY 1, 2 ORDER BY 1, 2
     ON CONFLICT (game_id, day) DO UPDATE
       SET robux = revenue_daily.robux + EXCLUDED.robux,
           purchases = revenue_daily.purchases + EXCLUDED.purchases`,
    [newIds],
  );

  // Sessions: every join opens one, every leave closes that player's most recent
  // open session on that server that started before the leave. Joins go first
  // so a join and leave in the same batch pair up. A leave with no open session
  // (its join was never sent) matches nothing and is ignored.
  await client.query(
    `INSERT INTO player_sessions (game_id, server_id, player_id, joined_at)
     SELECT game_id, server_id, player_id, occurred_at FROM (${NEW_EVENTS}) e
     WHERE type = 'player_join'`,
    [newIds],
  );
  await client.query(
    `UPDATE player_sessions s SET left_at = l.occurred_at
     FROM (${NEW_EVENTS}) l
     WHERE l.type = 'player_leave'
       AND s.id = (
         SELECT o.id FROM player_sessions o
         WHERE o.game_id = l.game_id AND o.server_id = l.server_id AND o.player_id = l.player_id
           AND o.left_at IS NULL AND o.joined_at <= l.occurred_at
         ORDER BY o.joined_at DESC
         LIMIT 1
       )`,
    [newIds],
  );
}
