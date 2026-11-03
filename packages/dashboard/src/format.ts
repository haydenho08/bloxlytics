import type { FeedEvent } from "@bloxlytics/shared/dashboard";

// Pure display helpers, kept out of the components so they can be unit tested.

const integer = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(n: number): string {
  return Math.abs(n) >= 10_000 ? compact.format(n) : integer.format(n);
}

export function formatRobux(n: number): string {
  return `R$ ${formatCount(n)}`;
}

/** Share retained, 0..100, or null while it can't be known yet (or nobody was in the cohort). */
export function retentionPct(retained: number | null, cohortSize: number): number | null {
  if (retained === null || cohortSize === 0) return null;
  return Math.round((retained / cohortSize) * 1000) / 10;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-03-10" -> "Mar 10". Parsed by hand: `new Date("2026-03-10")` is UTC
 * midnight, which prints as Mar 9 for anyone west of Greenwich.
 */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${date}`;
}

/** Epoch ms -> "14:05" in the viewer's own time zone (an instant, unlike a day). */
export function minuteLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function timeAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** One line for the live feed. */
export function describeEvent(e: FeedEvent): string {
  switch (e.type) {
    case "player_join":
      return "joined";
    case "player_leave":
      return "left";
    case "purchase": {
      const { product_id, robux } = e.properties as { product_id?: unknown; robux?: unknown };
      return `bought ${String(product_id)} for ${formatRobux(Number(robux ?? 0))}`;
    }
    case "custom": {
      const props = Object.entries(e.properties);
      if (props.length === 0) return e.name ?? "custom";
      const shown = props.slice(0, 3).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      return `${e.name} ${shown.join(" ")}${props.length > 3 ? " …" : ""}`;
    }
  }
}
