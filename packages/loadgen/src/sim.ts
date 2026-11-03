import { randomUUID } from "node:crypto";
import type { GameEventInput } from "@bloxlytics/shared";

/**
 * One simulated Roblox game server, behaving like the Luau SDK: events go into
 * a buffer, which is sent when it reaches `batchSize` or every `flushMs`,
 * whichever comes first, with at most one request in flight per server.
 *
 * Events are generated on a clock (open loop), not "after the last request
 * finished" (closed loop). If the API slows down, events pile up in the buffer
 * the way they would in a real game, instead of the load quietly dropping to
 * match what the API can take. That's what makes the measured rate honest.
 */
export interface SimOptions {
  gameId: string;
  serverId: string;
  players: number;
  /** Events per player per second (all types together). */
  eventsPerPlayerSec: number;
  batchSize: number;
  flushMs: number;
}

const PRODUCTS = [
  { product_id: "speed_coil", robux: 25 },
  { product_id: "double_jump", robux: 50 },
  { product_id: "pet_egg", robux: 100 },
  { product_id: "vip_pass", robux: 400 },
] as const;
const CUSTOM = ["coin_collected", "checkpoint_reached", "level_up", "enemy_defeated"] as const;

let nextPlayerId = 5_000_000_001;

export class GameServerSim {
  readonly opts: SimOptions;
  private readonly online: number[] = [];
  private buffer: GameEventInput[] = [];
  private owed = 0;
  private lastFlush = Date.now();
  inFlight = false;

  constructor(opts: SimOptions) {
    this.opts = opts;
    for (let i = 0; i < opts.players; i++) this.join();
    // Start each server at a random point in its batch and flush cycles. Real
    // servers started at different times; without this, every simulated server
    // fills its batch at the same moment and they all POST in the same
    // millisecond, measuring a thundering herd instead of the API.
    this.owed = Math.random() * opts.batchSize;
    this.lastFlush = Date.now() - Math.random() * opts.flushMs;
  }

  setRate(eventsPerPlayerSec: number): void {
    this.opts.eventsPerPlayerSec = eventsPerPlayerSec;
  }

  get buffered(): number {
    return this.buffer.length;
  }

  /** Adds the events due in the last `elapsedMs`. Fractions carry over, so low rates still add up. */
  generate(elapsedMs: number): void {
    this.owed += (this.opts.players * this.opts.eventsPerPlayerSec * elapsedMs) / 1000;
    while (this.owed >= 1) {
      this.owed -= 1;
      this.randomEvent();
    }
  }

  /** The next batch to send, if one is due; null otherwise. */
  takeBatch(now: number): GameEventInput[] | null {
    if (this.inFlight || this.buffer.length === 0) return null;
    if (this.buffer.length < this.opts.batchSize && now - this.lastFlush < this.opts.flushMs) return null;
    this.lastFlush = now;
    // 100 is the API's maximum batch, as in the SDK's drain.
    return this.buffer.splice(0, Math.min(this.buffer.length, 100));
  }

  /** A failed batch goes back to the front, to be resent as-is (same event_ids). */
  putBack(batch: GameEventInput[]): void {
    this.buffer = batch.concat(this.buffer);
  }

  private randomEvent(): void {
    const r = Math.random();
    // About 1 in 500 events is a player leaving, replaced by a new one joining:
    // players come and go, so sessions open and close all the time.
    if (r < 0.002 && this.online.length > 0) {
      const i = Math.floor(Math.random() * this.online.length);
      const [playerId] = this.online.splice(i, 1);
      this.push("player_leave", playerId!);
      this.join();
    } else if (r < 0.012) {
      this.push("purchase", this.randomPlayer(), { properties: { ...PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)]! } });
    } else {
      const name = CUSTOM[Math.floor(Math.random() * CUSTOM.length)]!;
      this.push("custom", this.randomPlayer(), { name, properties: { value: Math.floor(Math.random() * 100) } });
    }
  }

  private join(): void {
    const playerId = nextPlayerId++;
    this.online.push(playerId);
    this.push("player_join", playerId);
  }

  private randomPlayer(): number {
    return this.online[Math.floor(Math.random() * this.online.length)]!;
  }

  private push(type: GameEventInput["type"], playerId: number, extra: object = {}): void {
    this.buffer.push({
      event_id: randomUUID(),
      game_id: this.opts.gameId,
      server_id: this.opts.serverId,
      player_id: playerId,
      type,
      timestamp: Date.now(),
      ...extra,
    } as GameEventInput);
  }
}
