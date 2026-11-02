import { z } from "zod";
import { storedGameEvent, type GameEvent } from "./events.ts";

export const DEFAULT_EVENTS_STREAM = "gp:events";
/** Where the worker parks events it can't store, with the reason, for a human to look at. */
export const DEFAULT_DEAD_LETTER_STREAM = "gp:events:dlq";

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

const receivedAt = z.object({ received_at: z.number().int() });

/**
 * The worker's side of encodeStreamEvent. The API already validated the event, but
 * the stream is a boundary between two programs that deploy separately, so check
 * again rather than trust it. Throws (SyntaxError or ZodError) on a bad entry.
 */
export function decodeStreamEvent(json: string): StreamEvent {
  const raw: unknown = JSON.parse(json);
  return { ...storedGameEvent.parse(raw), ...receivedAt.parse(raw) };
}
