-- Games and their API keys.
--
-- Keys live in their own table (not a column on games) so a game can have more
-- than one: issue a new key, roll it out to the game, then revoke the old one.

CREATE TABLE games (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id    text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  -- SHA-256 of the full key, hex. The key itself is shown once and never stored.
  key_hash   text NOT NULL,
  -- First few characters, safe to show in a UI so people can tell keys apart.
  key_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Every authenticated request looks a key up by hash, so this is the hot path.
CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_game_id_idx ON api_keys (game_id);
