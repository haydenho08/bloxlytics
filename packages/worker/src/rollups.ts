import type { Pool } from "pg";
import type { RollupConfig } from "./config.ts";

// Every worker runs this job, but only one at a time should: the lock makes the
// others skip their turn instead of doing the same work twice.
const ROLLUP_LOCK_ID = 727_002;

/**
 * Events are accepted up to 7 days late. A cohort's numbers depend on its own
 * day and the days 1 and 7 after it, so a late event can still change cohorts
 * up to 14 days back. One extra day of margin.
 */
export const RETENTION_WINDOW_DAYS = 15;

/**
 * Recomputes the rollups that can't be kept up to date one event at a time, over
 * a recent window, replacing what was there. Returns false if another worker
 * held the lock and this run was skipped.
 *
 * Unlike the write-time rollups in store.ts, these are idempotent by overwriting:
 * running the job twice gives the same rows as running it once.
 */
export async function refreshRollups(pool: Pool, cfg: RollupConfig, now = new Date()): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [ROLLUP_LOCK_ID],
    );
    if (!rows[0]?.locked) {
      await client.query("ROLLBACK");
      return false;
    }

    // Players online per minute. A player's presence spans every minute from
    // join to leave, so one event affects many rows; easier to recompute the
    // window from sessions than to patch counts.
    const windowStart = new Date(now.getTime() - cfg.onlineWindowMinutes * 60_000);
    const staleBefore = new Date(now.getTime() - cfg.serverStaleAfterMs);
    await client.query(
      "DELETE FROM players_online_minute WHERE minute >= date_trunc('minute', $1::timestamptz)",
      [windowStart],
    );
    await client.query(
      `WITH minutes AS (
         SELECT generate_series(date_trunc('minute', $1::timestamptz), date_trunc('minute', $2::timestamptz),
                                interval '1 minute') AS minute
       ),
       sessions AS (
         -- An open session lasts until now if its server is still talking to us,
         -- and ended when the server was last heard from if it has gone quiet
         -- (it crashed, so no player_leave will ever come).
         SELECT s.game_id, s.player_id, s.joined_at,
                COALESCE(s.left_at,
                         CASE WHEN g.last_seen_at >= $3::timestamptz THEN 'infinity'::timestamptz
                              ELSE g.last_seen_at END) AS ended_at
         FROM player_sessions s
         JOIN game_servers g USING (game_id, server_id)
         WHERE s.left_at IS NULL OR s.left_at >= $1::timestamptz
       )
       INSERT INTO players_online_minute (game_id, minute, players)
       SELECT s.game_id, m.minute, count(DISTINCT s.player_id)
       FROM minutes m
       JOIN sessions s ON s.joined_at < m.minute + interval '1 minute' AND s.ended_at > m.minute
       GROUP BY 1, 2`,
      [windowStart, now, staleBefore],
    );

    // Day-1 and day-7 retention per cohort (first-seen day). Recomputed because
    // a late event can move a player's first day, which moves them between cohorts.
    const today = utcDay(now);
    const firstCohort = utcDay(new Date(now.getTime() - RETENTION_WINDOW_DAYS * 86_400_000));
    await client.query("DELETE FROM retention_daily WHERE cohort_day >= $1::date", [firstCohort]);
    await client.query(
      `INSERT INTO retention_daily (game_id, cohort_day, cohort_size, d1_retained, d7_retained, computed_at)
       SELECT p.game_id, p.first_seen_day, count(*),
              CASE WHEN p.first_seen_day + 1 < $2::date THEN count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM player_days d
                WHERE d.game_id = p.game_id AND d.player_id = p.player_id AND d.day = p.first_seen_day + 1))
              END,
              CASE WHEN p.first_seen_day + 7 < $2::date THEN count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM player_days d
                WHERE d.game_id = p.game_id AND d.player_id = p.player_id AND d.day = p.first_seen_day + 7))
              END,
              $3::timestamptz
       FROM players p
       WHERE p.first_seen_day >= $1::date
       GROUP BY p.game_id, p.first_seen_day`,
      [firstCohort, today, now],
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** "YYYY-MM-DD" of the UTC day containing t. */
export function utcDay(t: Date): string {
  return t.toISOString().slice(0, 10);
}
