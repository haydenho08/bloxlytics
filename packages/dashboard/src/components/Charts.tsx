import type { DauPoint, RetentionPoint, RevenuePoint } from "@bloxlytics/shared/dashboard";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api.ts";
import { dayLabel, formatCount, formatRobux, minuteLabel, retentionPct } from "../format.ts";
import { usePolling } from "../hooks.ts";
import { ChartState, Panel, Toggle } from "./Panel.tsx";

const HEIGHT = 240;
const axis = { stroke: "var(--muted)", fontSize: 12, tickLine: false, axisLine: false } as const;
const grid = <CartesianGrid stroke="var(--grid)" vertical={false} />;
const tooltip = {
  contentStyle: { background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" },
  labelStyle: { color: "var(--muted)" },
  cursor: { fill: "var(--grid)" },
} as const;

/** How often charts refetch. The rollups they read are refreshed every 15s at most. */
const FAST_MS = 15_000;
const SLOW_MS = 60_000;

const RANGES = [
  { value: 60, label: "1h" },
  { value: 360, label: "6h" },
  { value: 1440, label: "24h" },
] as const;

export function OnlineChart({ gameId }: { gameId: string }) {
  const [minutes, setMinutes] = useState<number>(60);
  const { data, error } = usePolling(`${gameId}:${minutes}`, (s) => api.online(gameId, minutes, s), FAST_MS);
  return (
    <Panel
      title="Players online"
      note="Distinct players in a session at any point in each minute"
      action={<Toggle options={RANGES} value={minutes} onChange={setMinutes} />}
      className="wide"
    >
      <ChartState error={error} loading={!data} empty={data?.every((p) => p.players === 0)} />
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <AreaChart data={data ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          {grid}
          <XAxis dataKey="minute" tickFormatter={minuteLabel} minTickGap={48} {...axis} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip
            {...tooltip}
            labelFormatter={(m) => minuteLabel(Number(m))}
            formatter={(v) => [formatCount(Number(v)), "Players"]}
          />
          <Area
            type="monotone"
            dataKey="players"
            stroke="var(--c1)"
            fill="var(--c1-soft)"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function DauChart({ gameId }: { gameId: string }) {
  const { data, error } = usePolling<DauPoint[]>(gameId, (s) => api.dau(gameId, 30, s), SLOW_MS);
  return (
    <Panel title="Daily active users" note="Last 30 days (UTC)">
      <ChartState error={error} loading={!data} empty={data?.every((p) => p.users === 0)} />
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <AreaChart data={data ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          {grid}
          <XAxis dataKey="day" tickFormatter={dayLabel} minTickGap={32} {...axis} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip
            {...tooltip}
            labelFormatter={(d) => dayLabel(String(d))}
            formatter={(v) => [formatCount(Number(v)), "Users"]}
          />
          <Area type="monotone" dataKey="users" stroke="var(--c2)" fill="var(--c2-soft)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function RevenueChart({ gameId }: { gameId: string }) {
  const { data, error } = usePolling<RevenuePoint[]>(gameId, (s) => api.revenue(gameId, 30, s), SLOW_MS);
  return (
    <Panel title="Revenue" note="Robux from purchases per day, last 30 days (UTC)">
      <ChartState error={error} loading={!data} empty={data?.every((p) => p.robux === 0)} />
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={data ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          {grid}
          <XAxis dataKey="day" tickFormatter={dayLabel} minTickGap={32} {...axis} />
          <YAxis tickFormatter={(v: number) => formatCount(v)} {...axis} />
          <Tooltip
            {...tooltip}
            labelFormatter={(d) => dayLabel(String(d))}
            formatter={(v, _name, item) => [
              `${formatRobux(Number(v))} · ${formatCount((item.payload as RevenuePoint).purchases)} purchases`,
              "Revenue",
            ]}
          />
          <Bar dataKey="robux" fill="var(--c3)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function RetentionChart({ gameId }: { gameId: string }) {
  const { data, error } = usePolling<RetentionPoint[]>(gameId, (s) => api.retention(gameId, 14, s), SLOW_MS);
  const rows = (data ?? []).map((r) => ({
    ...r,
    d1: retentionPct(r.d1_retained, r.cohort_size),
    d7: retentionPct(r.d7_retained, r.cohort_size),
  }));
  return (
    <Panel
      title="Retention"
      note="Of the players first seen each day, % who came back 1 and 7 days later. Blank until that day is over."
      className="wide"
    >
      <ChartState error={error} loading={!data} empty={data?.every((r) => r.cohort_size === 0)} />
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          {grid}
          <XAxis dataKey="cohort_day" tickFormatter={dayLabel} {...axis} />
          <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} {...axis} />
          <Tooltip
            {...tooltip}
            labelFormatter={(d, payload) => {
              const size = (payload[0]?.payload as RetentionPoint | undefined)?.cohort_size ?? 0;
              return `${dayLabel(String(d))} cohort · ${formatCount(size)} new players`;
            }}
            formatter={(v, name) => [v === null ? "not yet" : `${v}%`, name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="d1" name="Day 1" fill="var(--c1)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="d7" name="Day 7" fill="var(--c2)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

