import type {
  DauPoint,
  GameSummary,
  OnlinePoint,
  Overview,
  RetentionPoint,
  RevenuePoint,
} from "@bloxlytics/shared/dashboard";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const game = (id: string) => `/api/games/${encodeURIComponent(id)}`;

export const api = {
  games: (signal?: AbortSignal) => get<GameSummary[]>("/api/games", signal),
  overview: (id: string, signal?: AbortSignal) => get<Overview>(`${game(id)}/overview`, signal),
  online: (id: string, minutes: number, signal?: AbortSignal) =>
    get<OnlinePoint[]>(`${game(id)}/online?minutes=${minutes}`, signal),
  dau: (id: string, days: number, signal?: AbortSignal) => get<DauPoint[]>(`${game(id)}/dau?days=${days}`, signal),
  revenue: (id: string, days: number, signal?: AbortSignal) =>
    get<RevenuePoint[]>(`${game(id)}/revenue?days=${days}`, signal),
  retention: (id: string, days: number, signal?: AbortSignal) =>
    get<RetentionPoint[]>(`${game(id)}/retention?days=${days}`, signal),
  liveUrl: (id: string) => `${game(id)}/live`,
};
