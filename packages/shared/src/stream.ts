import { z } from "zod";
import { serverHeartbeat, storedGameEvent, type GameEvent, type ServerHeartbeat } from "./events.ts";

export const DEFAULT_EVENTS_STREAM = "gp:events";
/** Where the worker parks events it can't store, with the reason, for a human to look at. */
export const DEFAULT_DEAD_LETTER_STREAM = "gp:events:dlq";

/**
 * Each stream entry has a single field. Its name says what the entry is, and its
 * value is the JSON: "e" for an event, "h" for a server heartbeat.
 */
export const STREAM_EVENT_FIELD = "e";
export const STREAM_HEARTBEAT_FIELD = "h";

/** What the API puts on the stream: the validated event plus when we got it. */
export type StreamEvent = GameEvent & {
  /** Server receive time, epoch ms. Game clocks drift; ours is the tiebreaker. */
  received_at: number;
};

export type StreamHeartbeat = ServerHeartbeat & { received_at: number };

export function encodeStreamEvent(event: GameEvent, receivedAt: number): string {
  const entry: StreamEvent = { ...event, received_at: receivedAt };
  return JSON.stringify(entry);
}

export function encodeStreamHeartbeat(heartbeat: ServerHeartbeat, receivedAt: number): string {
  const entry: StreamHeartbeat = { ...heartbeat, received_at: receivedAt };
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

export function decodeStreamHeartbeat(json: string): StreamHeartbeat {
  const raw: unknown = JSON.parse(json);
  return { ...serverHeartbeat.parse(raw), ...receivedAt.parse(raw) };
}
