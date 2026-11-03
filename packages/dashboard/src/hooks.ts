import type { FeedEvent, Overview } from "@bloxlytics/shared/dashboard";
import { useEffect, useState } from "react";
import { api } from "./api.ts";

export interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
}

/**
 * Fetches now and then every `everyMs`, refetching from scratch when `key`
 * changes (a different game or range). Charts poll rather than stream: they
 * change at most once per rollup refresh (15s), so pushing them would buy nothing.
 */
export function usePolling<T>(key: string, load: (signal: AbortSignal) => Promise<T>, everyMs: number): Polled<T> {
  const [state, setState] = useState<Polled<T> & { key?: string }>({ data: undefined, error: undefined });

  useEffect(() => {
    const controller = new AbortController();
    const run = () =>
      load(controller.signal).then(
        (data) => setState({ key, data, error: undefined }),
        (err: unknown) => {
          if (!controller.signal.aborted) setState((s) => ({ ...s, key, error: String(err) }));
        },
      );
    void run();
    const timer = setInterval(() => void run(), everyMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // `load` is a new function every render; `key` says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, everyMs]);

  // Don't show the previous game's numbers while the new game's are loading.
  return state.key === key ? state : { data: undefined, error: undefined };
}

export type LiveStatus = "connecting" | "live" | "reconnecting";

export interface Live {
  status: LiveStatus;
  overview: Overview | undefined;
  /** Newest first. */
  events: FeedEvent[];
}

const MAX_FEED = 100;

/**
 * Subscribes to the game's Server-Sent Events stream. EventSource reconnects by
 * itself after a drop. On every (re)connect the server replays its recent
 * events, so duplicates are expected and removed by event_id: the same
 * at-least-once-plus-dedupe idea as the worker, on a smaller scale.
 */
export function useLive(gameId: string | undefined): Live {
  const [live, setLive] = useState<Live & { gameId?: string }>({ status: "connecting", overview: undefined, events: [] });

  useEffect(() => {
    if (!gameId) return;
    const source = new EventSource(api.liveUrl(gameId));
    const update = (patch: (prev: Live) => Partial<Live>) =>
      setLive((prev) => {
        const base = prev.gameId === gameId ? prev : { status: "connecting" as const, overview: undefined, events: [] };
        return { ...base, ...patch(base), gameId };
      });

    source.onopen = () => update(() => ({ status: "live" }));
    source.onerror = () => update(() => ({ status: "reconnecting" }));
    source.addEventListener("overview", (msg) => {
      const overview = JSON.parse((msg as MessageEvent<string>).data) as Overview;
      update(() => ({ overview, status: "live" }));
    });
    source.addEventListener("game_event", (msg) => {
      const event = JSON.parse((msg as MessageEvent<string>).data) as FeedEvent;
      update((prev) =>
        prev.events.some((e) => e.event_id === event.event_id)
          ? {}
          : { events: [event, ...prev.events].slice(0, MAX_FEED) },
      );
    });
    return () => source.close();
  }, [gameId]);

  return live.gameId === gameId ? live : { status: "connecting", overview: undefined, events: [] };
}

/** Re-renders every `everyMs` so "12s ago" labels keep counting. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
