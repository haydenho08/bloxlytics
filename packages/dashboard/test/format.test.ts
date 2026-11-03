import type { FeedEvent } from "@bloxlytics/shared/dashboard";
import { describe, expect, it } from "vitest";
import { dayLabel, describeEvent, formatCount, formatRobux, retentionPct, timeAgo } from "../src/format.ts";

const event = (overrides: Partial<FeedEvent>): FeedEvent => ({
  event_id: "e",
  game_id: "g",
  server_id: "s",
  player_id: 1,
  type: "player_join",
  timestamp: 0,
  received_at: 0,
  properties: {},
  ...overrides,
});

describe("format", () => {
  it("labels a UTC day without shifting it into the viewer's time zone", () => {
    expect(dayLabel("2026-03-01")).toBe("Mar 1");
    expect(dayLabel("2026-12-31")).toBe("Dec 31");
  });

  it("retention is null when it isn't known yet or the cohort is empty", () => {
    expect(retentionPct(1, 3)).toBe(33.3);
    expect(retentionPct(null, 50)).toBeNull();
    expect(retentionPct(0, 0)).toBeNull();
    expect(retentionPct(0, 10)).toBe(0);
  });

  it("formats counts and robux", () => {
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(25_300)).toBe("25.3K");
    expect(formatRobux(400)).toBe("R$ 400");
  });

  it("time ago", () => {
    expect(timeAgo(10_000, 15_000)).toBe("5s ago");
    expect(timeAgo(0, 125_000)).toBe("2m ago");
    expect(timeAgo(20_000, 10_000)).toBe("0s ago"); // a game server clock slightly ahead
  });

  it("describes each event type", () => {
    expect(describeEvent(event({ type: "player_join" }))).toBe("joined");
    expect(describeEvent(event({ type: "purchase", properties: { product_id: "sword", robux: 75 } }))).toBe(
      "bought sword for R$ 75",
    );
    expect(describeEvent(event({ type: "custom", name: "level_up", properties: { level: 3 } }))).toBe(
      "level_up level=3",
    );
    expect(describeEvent(event({ type: "custom", name: "ping" }))).toBe("ping");
  });
});
