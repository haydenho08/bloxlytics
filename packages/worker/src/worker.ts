import { setTimeout as sleep } from "node:timers/promises";
import { decodeStreamEvent, STREAM_EVENT_FIELD, type StreamEvent } from "@gamepulse/shared";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { Logger } from "pino";
import type { ConsumerConfig } from "./config.ts";
import { errorMessage, isPermanentDbError } from "./errors.ts";
import { defineScripts } from "./redisScripts.ts";
import { storeEvents } from "./store.ts";

/** A stream entry as Redis returns it: [id, [field, value, field, value, ...]]. */
type Entry = [id: string, fields: string[]];

interface Decoded {
  id: string;
  raw: string;
  event: StreamEvent;
}

export type DeadLetterReason = "invalid" | "rejected" | "too_many_deliveries";

interface DeadLetter {
  id: string;
  raw: string;
  reason: DeadLetterReason;
  error: string;
}

export interface WorkerDeps {
  pool: Pool;
  redis: Redis;
  config: ConsumerConfig;
  log: Logger;
}

/** Keep the dead letter stream from growing without limit if something goes badly wrong. */
const DEAD_LETTER_MAX_LEN = 100_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Reads events from the stream as one consumer in a consumer group and stores them.
 *
 * The contract with Redis is at-least-once: an entry stays in this consumer's
 * pending list until we XACK it, and we only XACK after the Postgres transaction
 * has committed. Crash at any point before that and the entry is redelivered;
 * crash just after the commit and it's redelivered too, but storeEvents is
 * idempotent, so the second delivery changes nothing. At-least-once delivery plus
 * idempotent processing gives the effect of exactly-once.
 */
export class EventWorker {
  private readonly pool: Pool;
  private readonly redis: Redis;
  private readonly cfg: ConsumerConfig;
  private readonly log: Logger;
  private readonly stopController = new AbortController();
  /** A batch that hit a transient error. Retried before anything new is read. */
  private retrying: { entries: Entry[]; deliveries: Map<string, number> } | null = null;
  private claimCursor = "0-0";
  private nextClaimAt = 0;

  constructor(deps: WorkerDeps) {
    this.pool = deps.pool;
    this.redis = deps.redis;
    this.cfg = deps.config;
    this.log = deps.log;
    defineScripts(this.redis);
  }

  /** Creates the consumer group if it doesn't exist yet. Safe to call from every worker. */
  async init(): Promise<void> {
    try {
      // "0": a brand-new group starts from the beginning of the stream, so events
      // queued before the first worker ever ran aren't skipped.
      await this.redis.xgroup("CREATE", this.cfg.stream, this.cfg.group, "0", "MKSTREAM");
    } catch (err) {
      if (!errorMessage(err).startsWith("BUSYGROUP")) throw err;
    }
  }

  /** Runs until stop() is called, backing off on errors. */
  async run(): Promise<void> {
    await this.init();
    let failures = 0;
    while (!this.stopping) {
      try {
        await this.processOnce();
        failures = 0;
      } catch (err) {
        if (this.stopping) break;
        if (errorMessage(err).startsWith("NOGROUP")) {
          // The stream or group was deleted under us; recreate and carry on.
          await this.init().catch(() => {});
          continue;
        }
        failures++;
        const delayMs = backoffMs(failures);
        this.log.error({ err, failures, delayMs }, "processing failed, will retry");
        await this.pause(delayMs);
      }
    }
    await this.leaveGroup();
  }

  /** Asks run() to finish the batch in hand and return. */
  stop(): void {
    this.stopController.abort();
  }

  private get stopping(): boolean {
    return this.stopController.signal.aborted;
  }

  /**
   * One step: retry a failed batch, else take over entries abandoned by dead
   * workers, else read new entries. Returns how many entries were handled.
   * Throws on transient errors; the same batch is retried on the next call.
   */
  async processOnce(): Promise<number> {
    if (this.retrying) {
      await this.renewLease(this.retrying.entries);
      return this.handle(this.retrying.entries, this.retrying.deliveries);
    }
    if (Date.now() >= this.nextClaimAt) {
      const claimed = await this.reclaim();
      if (claimed > 0) return claimed;
    }
    const entries = await this.read();
    return entries.length > 0 ? this.handle(entries) : 0;
  }

  private async read(): Promise<Entry[]> {
    // ">" means entries never delivered to any consumer in this group.
    const res = (await this.redis.xreadgroup(
      "GROUP", this.cfg.group, this.cfg.consumer,
      "COUNT", this.cfg.batchSize,
      "BLOCK", this.cfg.blockMs,
      "STREAMS", this.cfg.stream, ">",
    )) as [string, Entry[]][] | null;
    return res?.[0]?.[1] ?? [];
  }

  /**
   * Takes over entries that have sat unacknowledged for claimIdleMs: their worker
   * crashed or hung. XAUTOCLAIM bumps each entry's delivery count, which is how we
   * spot an entry that keeps killing whichever worker picks it up.
   */
  private async reclaim(): Promise<number> {
    const [next, claimed] = (await this.redis.xautoclaim(
      this.cfg.stream, this.cfg.group, this.cfg.consumer,
      this.cfg.claimIdleMs, this.claimCursor, "COUNT", this.cfg.batchSize,
    )) as [string, (Entry | null)[], string[]];
    // XAUTOCLAIM walks the pending list in pages; "0-0" means it reached the end.
    this.claimCursor = next;
    if (next === "0-0") this.nextClaimAt = Date.now() + Math.ceil(this.cfg.claimIdleMs / 4);

    const entries = claimed.filter((e): e is Entry => e !== null);
    if (entries.length === 0) return 0;

    const pending = (await this.redis.xpending(
      this.cfg.stream, this.cfg.group,
      entries[0]![0], entries.at(-1)![0], entries.length * 2, this.cfg.consumer,
    )) as [id: string, consumer: string, idleMs: number, deliveries: number][];
    const deliveries = new Map(pending.map(([id, , , n]) => [id, n]));
    this.log.warn({ entries: entries.length }, "reclaimed entries from a stalled consumer");
    return this.handle(entries, deliveries);
  }

  /**
   * While we retry a batch in-process, reset its idle time so no other worker
   * decides we're dead and claims it. JUSTID doesn't bump the delivery count, so a
   * long database outage doesn't push healthy events into the dead letter stream.
   */
  private async renewLease(entries: Entry[]): Promise<void> {
    await this.redis.xclaim(
      this.cfg.stream, this.cfg.group, this.cfg.consumer, 0,
      ...entries.map(([id]) => id), "JUSTID",
    );
  }

  private async handle(entries: Entry[], deliveries = new Map<string, number>()): Promise<number> {
    this.retrying = { entries, deliveries };

    const dead: DeadLetter[] = [];
    const decoded: Decoded[] = [];
    for (const [id, fields] of entries) {
      const raw = fieldValue(fields, STREAM_EVENT_FIELD) ?? "";
      const times = deliveries.get(id) ?? 1;
      if (times > this.cfg.maxDeliveries) {
        dead.push({ id, raw, reason: "too_many_deliveries", error: `delivered ${times} times` });
        continue;
      }
      try {
        decoded.push({ id, raw, event: decodeStreamEvent(raw) });
      } catch (err) {
        // Malformed entries will never get better; retrying them is pointless.
        dead.push({ id, raw, reason: "invalid", error: errorMessage(err) });
      }
    }

    const { stored, rejected, added } = await this.store(decoded);
    dead.push(...rejected);
    await this.acknowledge(stored.map((d) => d.id), dead);
    this.retrying = null;

    await this.redis.gpTrimAcked(this.cfg.stream);

    if (dead.length > 0) {
      this.log.warn(
        { deadLettered: dead.length, reasons: dead.map((d) => `${d.id}: ${d.reason}: ${d.error}`) },
        "moved entries to the dead letter stream",
      );
    }
    this.log.debug(
      { entries: entries.length, added, duplicates: stored.length - added, deadLettered: dead.length },
      "batch handled",
    );
    return entries.length;
  }

  /**
   * Stores the batch in one transaction. If that fails because of the data (not
   * an outage), one event is bad and it's taken the rest down with it: store
   * them one by one to find it, so the good ones aren't held up. Some may already
   * be stored if we retry after a crash halfway through; that's fine, storing is
   * idempotent. Transient errors are thrown so the whole batch gets retried.
   */
  private async store(items: Decoded[]): Promise<{ stored: Decoded[]; rejected: DeadLetter[]; added: number }> {
    if (items.length === 0) return { stored: [], rejected: [], added: 0 };
    try {
      const added = await storeEvents(this.pool, items.map((d) => d.event));
      return { stored: items, rejected: [], added };
    } catch (err) {
      if (!isPermanentDbError(err)) throw err;
      this.log.warn({ err, events: items.length }, "batch rejected by the database, storing events one by one");
    }

    const stored: Decoded[] = [];
    const rejected: DeadLetter[] = [];
    let added = 0;
    for (const item of items) {
      try {
        added += await storeEvents(this.pool, [item.event]);
        stored.push(item);
      } catch (err) {
        if (!isPermanentDbError(err)) throw err;
        rejected.push({ id: item.id, raw: item.raw, reason: "rejected", error: errorMessage(err) });
      }
    }
    return { stored, rejected, added };
  }

  /**
   * Dead-letters and acknowledges in one MULTI, so an entry can't be acknowledged
   * without its copy landing in the dead letter stream, or copied there twice.
   */
  private async acknowledge(storedIds: string[], dead: DeadLetter[]): Promise<void> {
    const ids = [...storedIds, ...dead.map((d) => d.id)];
    if (ids.length === 0) return;
    const tx = this.redis.multi();
    for (const d of dead) {
      tx.xadd(
        this.cfg.deadLetterStream, "MAXLEN", "~", DEAD_LETTER_MAX_LEN, "*",
        STREAM_EVENT_FIELD, d.raw,
        "source_id", d.id,
        "reason", d.reason,
        "error", d.error.slice(0, 1000),
        "failed_at", String(Date.now()),
      );
    }
    tx.xack(this.cfg.stream, this.cfg.group, ...ids);
    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (!results || failed) throw failed?.[0] ?? new Error("MULTI was aborted");
  }

  /** On a clean exit with nothing pending, remove this consumer so the group doesn't fill with dead names. */
  private async leaveGroup(): Promise<void> {
    try {
      const mine = await this.redis.xpending(this.cfg.stream, this.cfg.group, "-", "+", 1, this.cfg.consumer);
      if (mine.length === 0) {
        await this.redis.xgroup("DELCONSUMER", this.cfg.stream, this.cfg.group, this.cfg.consumer);
      }
    } catch (err) {
      this.log.warn({ err }, "could not leave the consumer group");
    }
  }

  private async pause(ms: number): Promise<void> {
    await sleep(ms, undefined, { signal: this.stopController.signal }).catch(() => {});
  }
}

function fieldValue(fields: string[], name: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === name) return fields[i + 1];
  }
  return undefined;
}

/** Exponential backoff with full jitter, so a fleet of workers doesn't retry in lockstep. */
export function backoffMs(failures: number): number {
  return Math.round(Math.random() * Math.min(MAX_BACKOFF_MS, 200 * 2 ** failures));
}
