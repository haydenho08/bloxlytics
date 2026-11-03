// Response shapes of the dashboard API, shared with the React app. Types only, no
// runtime code, so the browser bundle can import them without pulling in zod or
// anything Node-specific. Import from "@bloxlytics/shared/dashboard".
//
// Days are "YYYY-MM-DD" strings (UTC), never Date objects: a date has no time
// zone, and turning one into a JS Date silently shifts it by the viewer's offset.
// Instants are epoch milliseconds.

export interface GameSummary {
  id: string;
  name: string;
}

/** Headline numbers, right now. Pushed over the live stream every few seconds. */
export interface Overview {
  /** Players in an open session on a server that has been heard from recently. */
  online_now: number;
  servers_online: number;
  /** UTC today. */
  dau_today: number;
  robux_today: number;
  purchases_today: number;
  /** When these numbers were read, epoch ms. */
  as_of: number;
}

export interface OnlinePoint {
  /** Start of the minute, epoch ms. */
  minute: number;
  players: number;
}

export interface DauPoint {
  day: string;
  users: number;
}

export interface RevenuePoint {
  day: string;
  robux: number;
  purchases: number;
}

export interface RetentionPoint {
  cohort_day: string;
  /** Players first seen that day. 0 for a day with no new players. */
  cohort_size: number;
  /** null until the day being measured has finished. */
  d1_retained: number | null;
  d7_retained: number | null;
}

/** One event in the live feed: what the ingestion API put on the stream. */
export interface FeedEvent {
  event_id: string;
  game_id: string;
  server_id: string;
  player_id: number;
  type: "player_join" | "player_leave" | "purchase" | "custom";
  name?: string;
  timestamp: number;
  received_at: number;
  properties: Record<string, unknown>;
}

/** Server-sent event names on GET /api/games/:id/live. */
export type LiveMessage =
  | { event: "overview"; data: Overview }
  | { event: "game_event"; data: FeedEvent };
