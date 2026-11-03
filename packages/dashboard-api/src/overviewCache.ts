import type { Pool } from "@bloxlytics/db";
import type { Overview } from "@bloxlytics/shared/dashboard";
import { overview } from "./queries.ts";

/**
 * Every open live stream asks for its game's headline numbers every few seconds.
 * With 50 people watching one game that would be 50 identical queries; this
 * shares one result per game for `ttlMs`, so the database load depends on how
 * many games are being watched, not how many people are watching them.
 *
 * It caches the promise, not the value, so viewers asking at the same moment
 * share one query in flight too.
 */
export class OverviewCache {
  private readonly entries = new Map<string, { at: number; value: Promise<Overview> }>();

  constructor(
    private readonly pool: Pool,
    private readonly staleAfterMs: number,
    private readonly ttlMs = 1000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get(gameId: string): Promise<Overview> {
    const now = this.clock();
    const hit = this.entries.get(gameId);
    if (hit && now.getTime() - hit.at < this.ttlMs) return hit.value;

    const value = overview(this.pool, gameId, now, this.staleAfterMs);
    this.entries.set(gameId, { at: now.getTime(), value });
    // Don't keep handing out a failure; the next caller tries again.
    value.catch(() => {
      if (this.entries.get(gameId)?.value === value) this.entries.delete(gameId);
    });
    return value;
  }
}
