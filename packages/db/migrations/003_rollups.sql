-- Rollups: pre-aggregated tables the dashboard reads instead of raw events.
--
-- Two kinds, maintained differently (see docs/stage-2.md):
--   * Updated at write time, in the same transaction as the raw insert, from the
--     rows that insert actually added: daily_active_users, revenue_daily, and the
--     helper tables players, player_days, player_sessions, game_servers.
--   * Recomputed by a periodic job over a recent window, overwriting what was
--     there: players_online_minute, retention_daily.
-- All days are UTC days.

-- Last time each game server sent an event. A server that crashes never sends
-- player_leave, so its sessions would stay open forever; instead, sessions on a
-- server that has gone quiet are treated as ended when it was last seen.
CREATE TABLE game_servers (
  game_id      text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  server_id    text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (game_id, server_id)
);

-- One row per player per visit to one server: join to leave.
CREATE TABLE player_sessions (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id   text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  server_id text NOT NULL,
  player_id bigint NOT NULL,
  joined_at timestamptz NOT NULL,
  left_at   timestamptz
);
-- player_leave looks up the player's open session on that server.
CREATE INDEX player_sessions_open_idx ON player_sessions (game_id, server_id, player_id)
  WHERE left_at IS NULL;
-- The players-online job reads sessions still open or ended recently.
CREATE INDEX player_sessions_left_at_idx ON player_sessions (left_at);

-- First time we saw each player: their retention cohort.
CREATE TABLE players (
  game_id        text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id      bigint NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  first_seen_day date GENERATED ALWAYS AS ((first_seen_at AT TIME ZONE 'UTC')::date) STORED,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX players_cohort_idx ON players (game_id, first_seen_day);

-- Which days each player was active. The primary key makes "add this player to
-- today" idempotent, and its order serves retention's "was player P active on
-- day D?" lookups.
CREATE TABLE player_days (
  game_id   text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id bigint NOT NULL,
  day       date NOT NULL,
  PRIMARY KEY (game_id, player_id, day)
);

CREATE TABLE daily_active_users (
  game_id text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  day     date NOT NULL,
  users   integer NOT NULL,
  PRIMARY KEY (game_id, day)
);

CREATE TABLE revenue_daily (
  game_id   text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  day       date NOT NULL,
  robux     bigint NOT NULL,
  purchases integer NOT NULL,
  PRIMARY KEY (game_id, day)
);

-- Distinct players online at any point during each minute. A missing row means 0.
CREATE TABLE players_online_minute (
  game_id text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  minute  timestamptz NOT NULL,
  players integer NOT NULL,
  PRIMARY KEY (game_id, minute)
);

-- Of the players first seen on cohort_day, how many came back exactly 1 and 7
-- days later. NULL while that day hasn't finished yet, so a young cohort doesn't
-- show a misleading 0%.
CREATE TABLE retention_daily (
  game_id     text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  cohort_day  date NOT NULL,
  cohort_size integer NOT NULL,
  d1_retained integer,
  d7_retained integer,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, cohort_day)
);
