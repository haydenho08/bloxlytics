import type { GameEvent } from "./events.ts";

export const DEFAULT_EVENTS_STREAM = "gp:events";

/** Each stream entry has a single field holding the event as JSON. */
export const STREAM_EVENT_FIELD = "e";

/** What the API puts on the stream: the validated event plus when we got it. */
export type StreamEvent = GameEvent & {
  /** Server receive time, epoch ms. Game clocks drift; ours is the tiebreaker. */
  received_at: number;
};

export function encodeStreamEvent(event: GameEvent, receivedAt: number): string {
  const entry: StreamEvent = { ...event, received_at: receivedAt };
  return JSON.stringify(entry);
}
