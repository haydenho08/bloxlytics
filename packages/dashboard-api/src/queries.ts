import type { Pool } from "@bloxlytics/db";
import type {
  DauPoint,
  GameSummary,
  OnlinePoint,
  Overview,
  RetentionPoint,
  RevenuePoint,
} from "@bloxlytics/shared/dashboard";

// Every query here reads rollup tables, never the raw events table. Each chart
// reads at most a few hundred small rows, so it costs the same whether the game
// has had a thousand events or a billion.
//
// Two habits throughout:
//   * Series are gap-filled with generate_series: a rollup has no row for a
//     minute or day with no activity, but a chart needs the 0 drawn there.
//   * Days come back as text ('YYYY-MM-DD') and numbers as float8. node-postgres
//     turns a `date` into a JS Date at local midnight (off by a day for anyone
//     west of UTC), and a bigint into a string, to avoid losing precision.

export async function listGames(pool: Pool): Promise<GameSummary[]> {
  const { rows } = await pool.query<GameSummary>("SELECT id, name FROM games ORDER BY name, id");
  return rows;
}

export async function gameExists(pool: Pool, gameId: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM games WHERE id = $1", [gameId]);
  return rowCount === 1;
}

export async function overview(pool: Pool, gameId: string, now: Date, staleAfterMs: number): Promise<Overview> {
  const aliveSince = new Date(now.getTime() - staleAfterMs);
  const { rows } = await pool.query<Omit<Overview, "as_of">>(
    `SELECT
       -- Open sessions on servers still talking to us: the same rule the
       -- players-online job uses, applied to this instant. Uses the partial index
       -- on open sessions.
       (SELECT count(DISTINCT s.player_id)::float8
          FROM player_sessions s
          JOIN game_servers g USING (game_id, server_id)
         WHERE s.game_id = $1 AND s.left_at IS NULL AND g.last_seen_at >= $2) AS online_now,
       (SELECT count(*)::float8 FROM game_servers
         WHERE game_id = $1 AND last_seen_at >= $2) AS servers_online,
       COALESCE((SELECT users::float8 FROM daily_active_users WHERE game_id = $1 AND day = $3::date), 0) AS dau_today,
       COALESCE((SELECT robux::float8 FROM revenue_daily WHERE game_id = $1 AND day = $3::date), 0) AS robux_today,
       COALESCE((SELECT purchases::float8 FROM revenue_daily WHERE game_id = $1 AND day = $3::date), 0) AS purchases_today`,
    [gameId, aliveSince, utcDay(now)],
  );
  return { ...rows[0]!, as_of: now.getTime() };
}

/** Players online per minute for the last `minutes` minutes, oldest first, ending at now's minute. */
export async function onlineSeries(pool: Pool, gameId: string, now: Date, minutes: number): Promise<OnlinePoint[]> {
  const { rows } = await pool.query<OnlinePoint>(
    `SELECT (extract(epoch FROM m.minute) * 1000)::float8 AS minute,
            COALESCE(p.players, 0)::float8 AS players
     FROM generate_series(date_trunc('minute', $2::timestamptz) - ($3::int - 1) * interval '1 minute',
                          date_trunc('minute', $2::timestamptz), interval '1 minute') AS m(minute)
     LEFT JOIN players_online_minute p ON p.game_id = $1 AND p.minute = m.minute
     ORDER BY m.minute`,
    [gameId, now, minutes],
  );
  return rows;
}

/**
 * The last `days` UTC days, oldest first, ending today ($2). Counts back with
 * date - integer, which stays a `date`; a series of dates with an interval step
 * would come out as timestamps in the session's time zone.
 */
function daysSql(select: string, join: string): string {
  return `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, ${select}
          FROM generate_series($3::int - 1, 0, -1) AS back(n)
          CROSS JOIN LATERAL (SELECT $2::date - back.n AS day) AS d
          LEFT JOIN ${join}
          ORDER BY d.day`;
}

export async function dauSeries(pool: Pool, gameId: string, now: Date, days: number): Promise<DauPoint[]> {
  const { rows } = await pool.query<DauPoint>(
    daysSql("COALESCE(a.users, 0)::float8 AS users", "daily_active_users a ON a.game_id = $1 AND a.day = d.day"),
    [gameId, utcDay(now), days],
  );
  return rows;
}

export async function revenueSeries(pool: Pool, gameId: string, now: Date, days: number): Promise<RevenuePoint[]> {
  const { rows } = await pool.query<RevenuePoint>(
    daysSql(
      "COALESCE(r.robux, 0)::float8 AS robux, COALESCE(r.purchases, 0)::float8 AS purchases",
      "revenue_daily r ON r.game_id = $1 AND r.day = d.day",
    ),
    [gameId, utcDay(now), days],
  );
  return rows;
}

export async function retentionSeries(pool: Pool, gameId: string, now: Date, days: number): Promise<RetentionPoint[]> {
  const { rows } = await pool.query<RetentionPoint & { day: string }>(
    daysSql(
      `COALESCE(r.cohort_size, 0)::float8 AS cohort_size,
       r.d1_retained::float8 AS d1_retained, r.d7_retained::float8 AS d7_retained`,
      "retention_daily r ON r.game_id = $1 AND r.cohort_day = d.day",
    ),
    [gameId, utcDay(now), days],
  );
  return rows.map(({ day, ...r }) => ({ ...r, cohort_day: day }));
}

/** "YYYY-MM-DD" of the UTC day containing t. */
export function utcDay(t: Date): string {
  return t.toISOString().slice(0, 10);
}
