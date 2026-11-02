import { findGameIdByKeyHash, hashApiKey, isWellFormedApiKey, type Pool } from "@gamepulse/db";

export const API_KEY_HEADER = "x-api-key";

interface CacheEntry {
  gameId: string | null;
  expiresAt: number;
}

export interface AuthenticatorOptions {
  /** How long a valid key is trusted without asking Postgres again. Also the revocation delay. */
  validTtlMs?: number;
  /** Unknown keys are cached too, so a flood of bad keys can't hammer the database. */
  invalidTtlMs?: number;
  maxEntries?: number;
}

/**
 * Resolves an API key to its game. Every ingest request needs this, so results are
 * cached in memory keyed by the key's hash (we never hold plaintext keys either).
 */
export class ApiKeyAuthenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly validTtlMs: number;
  private readonly invalidTtlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly pool: Pool,
    opts: AuthenticatorOptions = {},
  ) {
    this.validTtlMs = opts.validTtlMs ?? 60_000;
    this.invalidTtlMs = opts.invalidTtlMs ?? 10_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /** Returns the game id, or null if the key is missing, malformed, unknown or revoked. */
  async authenticate(key: string | undefined): Promise<string | null> {
    if (!key || !isWellFormedApiKey(key)) return null;

    const hash = hashApiKey(key);
    const now = Date.now();
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) return cached.gameId;

    const gameId = await findGameIdByKeyHash(this.pool, hash);
    this.remember(hash, gameId, now);
    return gameId;
  }

  private remember(hash: string, gameId: string | null, now: number): void {
    this.cache.delete(hash);
    if (this.cache.size >= this.maxEntries) {
      // Maps iterate in insertion order, so the first key is the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, {
      gameId,
      expiresAt: now + (gameId ? this.validTtlMs : this.invalidTtlMs),
    });
  }
}
