import type { FeedEvent } from "@bloxlytics/shared/dashboard";
import { describeEvent, timeAgo } from "../format.ts";
import { useNow } from "../hooks.ts";
import { Panel } from "./Panel.tsx";

const TYPE_LABEL: Record<FeedEvent["type"], string> = {
  player_join: "join",
  player_leave: "leave",
  purchase: "purchase",
  custom: "custom",
};

export function EventFeed({ events }: { events: FeedEvent[] }) {
  const now = useNow(1000);
  return (
    <Panel title="Live events" note="Straight off the stream, before the worker stores them" className="feed">
      {events.length === 0 ? (
        <p className="chart-msg">Waiting for events…</p>
      ) : (
        <ol className="feed-list">
          {events.map((e) => (
            <li key={e.event_id}>
              <span className={`tag ${e.type}`}>{TYPE_LABEL[e.type]}</span>
              <span className="feed-text" title={describeEvent(e)}>
                <span className="player">Player {e.player_id}</span> {describeEvent(e)}
              </span>
              <time dateTime={new Date(e.timestamp).toISOString()} title={new Date(e.timestamp).toLocaleString()}>
                {timeAgo(e.timestamp, now)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
