import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

export const API_KEY_PREFIX = "gp_";
const API_KEY_PATTERN = /^gp_[A-Za-z0-9_-]{43}$/;

/** 32 random bytes = 256 bits of entropy, base64url so it's header- and URL-safe. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * A plain, fast SHA-256 is the right hash here, unlike for passwords. bcrypt and
 * friends are slow on purpose so guessing low-entropy human passwords is expensive.
 * A 256-bit random key can't be guessed no matter how fast the hash is, and we hash
 * on every request, so slowness would only cost us.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Cheap shape check so obviously bad keys never reach the database. */
export function isWellFormedApiKey(key: string): boolean {
  return API_KEY_PATTERN.test(key);
}

export interface CreatedGame {
  gameId: string;
  apiKey: string;
}

/** Creates a game and its first API key. The plaintext key is returned once, here. */
export async function createGame(pool: Pool, gameId: string, name: string): Promise<CreatedGame> {
  const apiKey = generateApiKey();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO games (id, name) VALUES ($1, $2)", [gameId, name]);
    await client.query("INSERT INTO api_keys (game_id, key_hash, key_prefix) VALUES ($1, $2, $3)", [
      gameId,
      hashApiKey(apiKey),
      apiKey.slice(0, 10),
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { gameId, apiKey };
}

/** Returns the game a key belongs to, or null if the key is unknown or revoked. */
export async function findGameIdByKeyHash(pool: Pool, keyHash: string): Promise<string | null> {
  const { rows } = await pool.query<{ game_id: string }>(
    "SELECT game_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [keyHash],
  );
  return rows[0]?.game_id ?? null;
}
