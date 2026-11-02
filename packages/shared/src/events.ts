import { z } from "zod";

// One schema, imported by both the API (to validate what comes in) and the
// worker (to type what it reads off the stream). If the two ever disagreed about
// the shape of an event, the bug would be silent; sharing the code makes it a
// compile error instead.

export const MAX_BATCH_SIZE = 100;
/** Serialized size cap for one event's properties, so one bad event can't blow up a row. */
export const MAX_PROPERTIES_BYTES = 8 * 1024;
/** Game servers' clocks drift; allow a little future skew but not garbage. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** The SDK buffers and retries, so events can arrive late, but not forever. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const EVENT_TYPES = ["player_join", "player_leave", "purchase", "custom"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// HttpService:GenerateGUID(false) gives e.g. "8F1A6C2E-...". Normalise to lower
// case so the same GUID can't sneak past the unique constraint in two spellings.
const eventId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a GUID")
  .transform((s) => s.toLowerCase());

export const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const gameId = z.string().regex(GAME_ID_PATTERN, "must be a lowercase slug");

// game.JobId in a live server; the SDK makes up a GUID in Studio, where JobId is "".
const serverId = z.string().min(1).max(64);

// Roblox UserIds are integers that already exceed 2^31, but stay below 2^53.
const playerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// Unix epoch milliseconds (DateTime.now().UnixTimestampMillis in Luau).
const epochMs = z.number().int();

// The clock checks are about when the API receives an event. The worker uses the
// same schemas without them: it may read an entry hours later (a backlog, a
// redelivery), and an event that was fresh on arrival mustn't turn "too old".
const clockCheckedTimestamp = epochMs
  .refine((t) => t <= Date.now() + MAX_FUTURE_SKEW_MS, "is too far in the future")
  .refine((t) => t >= Date.now() - MAX_EVENT_AGE_MS, "is too old");

const fitsSizeLimit = [
  (p: object) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PROPERTIES_BYTES,
  `must serialize to at most ${MAX_PROPERTIES_BYTES} bytes`,
] as const;

const jsonProperties = z.record(z.string().max(64), z.json()).refine(...fitsSizeLimit);

/** Builds the four event schemas around a given timestamp rule. */
function eventSchemas<T extends z.ZodType<number, number>>(timestamp: T) {
  const base = {
    event_id: eventId,
    game_id: gameId,
    server_id: serverId,
    player_id: playerId,
    timestamp,
  };

  const playerJoin = z.object({
    ...base,
    type: z.literal("player_join"),
    properties: jsonProperties.default({}),
  });

  const playerLeave = z.object({
    ...base,
    type: z.literal("player_leave"),
    properties: jsonProperties.default({}),
  });

  // Revenue rollups depend on these fields, so they're required and typed.
  // Anything extra the game wants to attach is kept, as long as it's JSON.
  const purchase = z.object({
    ...base,
    type: z.literal("purchase"),
    properties: z
      .object({
        product_id: z.union([z.string().min(1).max(64), z.number().int().nonnegative()]),
        robux: z.number().int().nonnegative(),
      })
      .catchall(z.json())
      .refine(...fitsSizeLimit),
  });

  const custom = z.object({
    ...base,
    type: z.literal("custom"),
    name: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "must be 1-64 chars of [A-Za-z0-9_.:-]"),
    properties: jsonProperties.default({}),
  });

  return {
    playerJoin,
    playerLeave,
    purchase,
    custom,
    any: z.discriminatedUnion("type", [playerJoin, playerLeave, purchase, custom]),
  };
}

const received = eventSchemas(clockCheckedTimestamp);

export const playerJoinEvent = received.playerJoin;
export const playerLeaveEvent = received.playerLeave;
export const purchaseEvent = received.purchase;
export const customEvent = received.custom;

/** What the API accepts: every rule, including the clock checks. */
export const gameEvent = received.any;

/** Every rule except the clock checks. The worker re-checks stream entries with this. */
export const storedGameEvent = eventSchemas(epochMs).any;

export const eventBatch = z.object({
  events: z.array(gameEvent).min(1).max(MAX_BATCH_SIZE),
});

/** An event after validation and normalisation. */
export type GameEvent = z.output<typeof gameEvent>;
export type EventBatch = z.output<typeof eventBatch>;
/** What a game server sends, before defaults/normalisation. */
export type GameEventInput = z.input<typeof gameEvent>;
