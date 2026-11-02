import { describe, expect, it } from "vitest";
import { MAX_EVENT_AGE_MS, MAX_PROPERTIES_BYTES, gameEvent } from "../src/index.ts";

const valid = {
  event_id: "8F1A6C2E-3B4D-4E5F-9A0B-1C2D3E4F5A6B",
  game_id: "my-obby",
  server_id: "server-1",
  player_id: 123456789,
  type: "player_join",
  timestamp: Date.now(),
};

describe("gameEvent schema", () => {
  it("normalises the GUID and defaults properties", () => {
    const e = gameEvent.parse(valid);
    expect(e.event_id).toBe("8f1a6c2e-3b4d-4e5f-9a0b-1c2d3e4f5a6b");
    expect(e.properties).toEqual({});
  });

  it("requires a name on custom events", () => {
    expect(gameEvent.safeParse({ ...valid, type: "custom" }).success).toBe(false);
    expect(gameEvent.safeParse({ ...valid, type: "custom", name: "boss_killed" }).success).toBe(true);
  });

  it("rejects unknown event types", () => {
    expect(gameEvent.safeParse({ ...valid, type: "teleport" }).success).toBe(false);
  });

  it("rejects timestamps far in the future or too old", () => {
    expect(gameEvent.safeParse({ ...valid, timestamp: Date.now() + 60 * 60_000 }).success).toBe(false);
    expect(gameEvent.safeParse({ ...valid, timestamp: Date.now() - MAX_EVENT_AGE_MS - 1000 }).success).toBe(false);
    // Seconds instead of milliseconds is a classic SDK bug; it reads as 1970.
    expect(gameEvent.safeParse({ ...valid, timestamp: Math.floor(Date.now() / 1000) }).success).toBe(false);
  });

  it("rejects non-integer or unsafe player ids", () => {
    expect(gameEvent.safeParse({ ...valid, player_id: 1.5 }).success).toBe(false);
    expect(gameEvent.safeParse({ ...valid, player_id: 2 ** 60 }).success).toBe(false);
  });

  it("caps the size of properties", () => {
    const big = { blob: "x".repeat(MAX_PROPERTIES_BYTES) };
    expect(gameEvent.safeParse({ ...valid, properties: big }).success).toBe(false);
  });

  it("validates purchase amounts", () => {
    const purchase = { ...valid, type: "purchase" };
    expect(gameEvent.safeParse({ ...purchase, properties: { product_id: 1, robux: 99 } }).success).toBe(true);
    expect(gameEvent.safeParse({ ...purchase, properties: { product_id: 1, robux: -5 } }).success).toBe(false);
    expect(gameEvent.safeParse({ ...purchase, properties: { product_id: 1, robux: 9.99 } }).success).toBe(false);
  });
});
