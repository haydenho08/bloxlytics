import { setTimeout as sleep } from "node:timers/promises";
import { decodeStreamEvent, STREAM_EVENT_FIELD, type StreamEvent } from "@bloxlytics/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

export type FeedListener = (event: StreamEvent) => void;

export interface LiveFeedOptions {
  /** A connection of its own: XREAD BLOCK ties it up until something arrives. */
  redis: Redis;
  stream: string;
  log: FastifyBaseLogger;
  blockMs?: number;
  /** Kept per game so a dashboard that has just opened isn't blank. */
  recentPerGame?: number;
}

type XReadReply = [stream: string, entries: [id: string, fields: string[]][]][] | null;

/**
 * Tails the events stream and fans each event out to the dashboards watching its
 * game.
 *
 * It reads with plain XREAD, NOT through the workers' consumer group. A consumer
 * group splits entries between its members, so joining it would steal events
 * from the workers. XREAD is a read-only cursor: it leaves no pending entries and
 * acknowledges nothing, so the workers can't tell we're here. Any number of
 * readers can tail the same stream this way.
 *
 * One loop per process, however many browsers are connected: the cost of
 * reading the stream doesn't grow with viewers, only the in-memory fan-out does.
 */
export class LiveFeed {
  private readonly redis: Redis;
  private readonly stream: string;
  private readonly log: FastifyBaseLogger;
  private readonly blockMs: number;
  private readonly recentPerGame: number;
  private readonly listeners = new Map<string, Set<FeedListener>>();
  private readonly recent = new Map<string, StreamEvent[]>();
  private lastId = "0-0";
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(opts: LiveFeedOptions) {
    this.redis = opts.redis;
    this.stream = opts.stream;
    this.log = opts.log;
    this.blockMs = opts.blockMs ?? 5000;
    this.recentPerGame = opts.recentPerGame ?? 50;
  }

  /**
   * Starts from what's in the stream now: the newest entries fill the recent
   * buffers, and reading continues after the newest one. Starting from "$" instead
   * would miss anything added between one XREAD returning and the next starting.
   */
  async start(): Promise<void> {
    const newest = (await this.redis.xrevrange(this.stream, "+", "-", "COUNT", this.recentPerGame * 4)).reverse();
    for (const [id, fields] of newest) this.accept(id, fields, false);
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Interrupts the blocked XREAD; the loop sees `stopped` and returns.
    this.redis.disconnect();
    await this.running;
  }

  /** Calls `listener` for each new event of `gameId`. Returns the unsubscribe function. */
  subscribe(gameId: string, listener: FeedListener): () => void {
    let set = this.listeners.get(gameId);
    if (!set) this.listeners.set(gameId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(gameId);
    };
  }

  /** The game's latest events, oldest first. */
  recentEvents(gameId: string): readonly StreamEvent[] {
    return this.recent.get(gameId) ?? [];
  }

  get viewerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const reply = (await this.redis.xread(
          "COUNT", 500, "BLOCK", this.blockMs, "STREAMS", this.stream, this.lastId,
        )) as XReadReply;
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) this.accept(id, fields, true);
        }
      } catch (err) {
        if (this.stopped) return;
        // Redis is down or restarting. ioredis reconnects by itself; wait a bit
        // rather than spin. The cursor is kept, so nothing still in the stream is missed.
        this.log.warn({ err }, "live feed read failed, retrying");
        await sleep(1000);
      }
    }
  }

  private accept(id: string, fields: string[], notify: boolean): void {
    this.lastId = id;
    // Entries are [field, value]. Heartbeats ("h") aren't shown in the feed.
    if (fields[0] !== STREAM_EVENT_FIELD || fields[1] === undefined) return;
    let event: StreamEvent;
    try {
      event = decodeStreamEvent(fields[1]);
    } catch {
      return; // The worker dead-letters bad entries; the feed just skips them.
    }

    let buffer = this.recent.get(event.game_id);
    if (!buffer) this.recent.set(event.game_id, (buffer = []));
    buffer.push(event);
    if (buffer.length > this.recentPerGame) buffer.shift();

    if (!notify) return;
    for (const listener of this.listeners.get(event.game_id) ?? []) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err }, "live feed listener threw");
      }
    }
  }
}
