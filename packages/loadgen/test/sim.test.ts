import { eventBatch } from "@bloxlytics/shared";
import { describe, expect, it } from "vitest";
import { GameServerSim } from "../src/sim.ts";
import { percentile } from "../src/stats.ts";

const sim = (overrides = {}) =>
  new GameServerSim({
    gameId: "loadtest",
    serverId: "s1",
    players: 10,
    eventsPerPlayerSec: 1,
    batchSize: 50,
    flushMs: 10_000,
    ...overrides,
  });

describe("GameServerSim", () => {
  it("makes batches the real API accepts", () => {
    const s = sim();
    s.generate(10_000); // 10 players x 1/s x 10s = 100, plus the 10 initial joins
    const batch = s.takeBatch(Date.now());
    expect(batch).toHaveLength(100);
    expect(eventBatch.safeParse({ events: batch }).success).toBe(true);
  });

  it("sends a partial batch once the flush interval has passed", () => {
    const s = sim({ players: 3, eventsPerPlayerSec: 0 });
    // Just the 3 joins: below the batch size, so only the timer can send them.
    expect(s.takeBatch(Date.now() + 10_001)).toHaveLength(3);
    expect(s.takeBatch(Date.now() + 10_002)).toBeNull();
  });

  it("keeps one request in flight, and a failed batch goes back to the front", () => {
    const s = sim();
    s.generate(10_000);
    const first = s.takeBatch(Date.now())!;
    s.inFlight = true;
    expect(s.takeBatch(Date.now())).toBeNull();
    s.inFlight = false;
    s.putBack(first);
    expect(s.takeBatch(Date.now())![0]!.event_id).toBe(first[0]!.event_id);
  });
});

describe("percentile", () => {
  it("nearest rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
});
