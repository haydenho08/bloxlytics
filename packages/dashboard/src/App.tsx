import type { GameSummary } from "@bloxlytics/shared/dashboard";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { DauChart, OnlineChart, RetentionChart, RevenueChart } from "./components/Charts.tsx";
import { EventFeed } from "./components/EventFeed.tsx";
import { Stat } from "./components/Panel.tsx";
import { formatCount, formatRobux } from "./format.ts";
import { useLive, usePolling, type LiveStatus } from "./hooks.ts";

/** The chosen game lives in the URL (?game=...), so a view can be bookmarked or shared. */
function useSelectedGame(games: GameSummary[] | undefined): [string | undefined, (id: string) => void] {
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get("game") ?? undefined);

  const select = (id: string) => {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("game", id);
    history.replaceState(null, "", url);
  };

  // Nothing (or an unknown game) in the URL: fall back to the first game.
  const valid = games?.some((g) => g.id === selected) ? selected : games?.[0]?.id;
  return [valid, select];
}

const STATUS_TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

export function App() {
  const games = usePolling("games", api.games, 60_000);
  const [gameId, selectGame] = useSelectedGame(games.data);
  const live = useLive(gameId);
  const o = live.overview;

  useEffect(() => {
    const name = games.data?.find((g) => g.id === gameId)?.name;
    document.title = name ? `${name} · Bloxlytics` : "Bloxlytics";
  }, [games.data, gameId]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▮
          </span>
          Bloxlytics
        </div>
        {games.data && games.data.length > 0 && (
          <label className="picker">
            <span>Game</span>
            <select value={gameId} onChange={(e) => selectGame(e.target.value)}>
              {games.data.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {gameId && (
          <span className={`status ${live.status}`} role="status">
            <span className="dot" aria-hidden /> {STATUS_TEXT[live.status]}
          </span>
        )}
      </header>

      {games.error && <p className="banner error">Can't reach the dashboard API ({games.error}). Is it running?</p>}
      {games.data?.length === 0 && (
        <div className="banner">
          No games yet. Create one with <code>npm.cmd run create-game -- my-game "My Game"</code>, then point the SDK
          at it.
        </div>
      )}

      {gameId && (
        <main className="grid">
          <div className="stats">
            <Stat label="Players online" value={o && formatCount(o.online_now)} live={live.status === "live"} />
            <Stat label="Servers" value={o && formatCount(o.servers_online)} sub="heard from in the last 5 min" />
            <Stat label="Active users today" value={o && formatCount(o.dau_today)} sub="UTC day" />
            <Stat
              label="Revenue today"
              value={o && formatRobux(o.robux_today)}
              sub={o && `${formatCount(o.purchases_today)} purchases`}
            />
          </div>
          <OnlineChart gameId={gameId} />
          <EventFeed events={live.events} />
          <DauChart gameId={gameId} />
          <RevenueChart gameId={gameId} />
          <RetentionChart gameId={gameId} />
        </main>
      )}
    </div>
  );
}
