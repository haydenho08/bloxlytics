import type { ReactNode } from "react";

export function Panel(props: { title: string; note?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      <header className="panel-head">
        <div>
          <h2>{props.title}</h2>
          {props.note && <p className="note">{props.note}</p>}
        </div>
        {props.action}
      </header>
      {props.children}
    </section>
  );
}

export function Stat(props: { label: string; value: string | undefined; sub?: string; live?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {props.live && <span className="dot" aria-hidden />}
        {props.label}
      </div>
      <div className="stat-value">{props.value ?? "–"}</div>
      {props.sub && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}

/** Shown in place of (or over) a chart: loading, an error, or nothing to show. */
export function ChartState(props: { error?: string; loading?: boolean; empty?: boolean }) {
  if (props.error) return <p className="chart-msg error">Couldn't load: {props.error}</p>;
  if (props.loading) return <p className="chart-msg">Loading…</p>;
  if (props.empty) return <p className="chart-msg">No activity in this range yet</p>;
  return null;
}

export function Toggle<T extends string | number>(props: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="toggle" role="group">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
