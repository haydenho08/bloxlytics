-- Raw events: one row per event, exactly once.
--
-- The stream delivers at least once (a worker can crash after committing but
-- before acknowledging, and the SDK retries batches whose response got lost), so
-- the same event can arrive more than once. The primary key on event_id is what
-- turns that into exactly-once storage: the worker inserts with
-- ON CONFLICT (event_id) DO NOTHING, and a repeat is silently skipped.

CREATE TABLE events (
  event_id    uuid PRIMARY KEY,
  game_id     text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  server_id   text NOT NULL,
  player_id   bigint NOT NULL,
  type        text NOT NULL CHECK (type IN ('player_join', 'player_leave', 'purchase', 'custom')),
  -- Only custom events have a name.
  name        text CHECK ((type = 'custom') = (name IS NOT NULL)),
  -- When it happened, by the game server's clock.
  occurred_at timestamptz NOT NULL,
  -- When the API received it, by ours. Lets us measure SDK delay and spot bad clocks.
  received_at timestamptz NOT NULL,
  -- When the worker stored it. received_at -> stored_at is the pipeline's lag.
  stored_at   timestamptz NOT NULL DEFAULT now(),
  properties  jsonb NOT NULL DEFAULT '{}'
);

-- Every query on raw events is "this game, this time range": recomputing a rollup
-- over a window, the dashboard's recent-events feed (a backwards scan of the same
-- index), ad-hoc debugging. game_id first because every query pins it to one
-- value; occurred_at second so the range is a contiguous slice of the index.
-- No index on player_id or type: nothing reads raw events that way. Per-player
-- questions go to the player rollup tables, and each extra index slows every insert.
CREATE INDEX events_game_time_idx ON events (game_id, occurred_at);
