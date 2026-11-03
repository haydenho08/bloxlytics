# Stage 4: Dashboard

**Goal:** pick a game and see players online, daily active users, retention and
revenue, plus a feed of events as they happen. The numbers come from the rollup
tables Stage 2 built, never from scanning raw events.

```
                                 ┌──────────── Redis stream bx:events ────────────┐
ingestion API ── XADD ─────────▶ │                                                 │
                                 └──┬───────────────────────────────┬─────────────┘
                     XREADGROUP (consumer group)            XREAD (plain cursor)
                                    │                               │
                                 worker(s)                   dashboard API ── SSE ──▶ browser: live feed
                                    │                          │    ▲                   + headline numbers
                                    ▼                          │    │
                         Postgres: events + rollups ◀── SELECT ┘    └── GET /api/... ◀── browser: charts
```

Two new packages:
- [`packages/dashboard-api`](../packages/dashboard-api/src/app.ts): Fastify,
  read-only, port 8082.
- [`packages/dashboard`](../packages/dashboard/src/App.tsx): React, Vite and
  Recharts, port 5180. Vite forwards `/api` to the dashboard API.

## The endpoints

| Route                                   | Reads                                   | Returns                          |
| --------------------------------------- | --------------------------------------- | -------------------------------- |
| `GET /api/games`                        | `games`                                 | id + name, for the picker        |
| `GET /api/games/:id/overview`           | `player_sessions`, `game_servers`, `daily_active_users`, `revenue_daily` | online now, servers, today's DAU and revenue |
| `GET /api/games/:id/online?minutes=60`  | `players_online_minute`                 | one point per minute (max 1440)  |
| `GET /api/games/:id/dau?days=30`        | `daily_active_users`                    | one point per UTC day (max 90)   |
| `GET /api/games/:id/revenue?days=30`    | `revenue_daily`                         | robux + purchases per day        |
| `GET /api/games/:id/retention?days=14`  | `retention_daily`                       | cohort size, d1 and d7 retained  |
| `GET /api/games/:id/live`               | the Redis stream + overview             | Server-Sent Events               |

Measured locally against the seeded demo game (p50): overview 3.5ms, 24 hours of
players online 10.6ms, 30 days of DAU 5.3ms.

## Design decisions (and the interview questions they answer)

### Why read rollups, not raw events?
> "How does your dashboard stay fast as data grows?"

"DAU for the last 30 days" from raw events is `COUNT(DISTINCT player_id)` over
every event in 30 days. That's millions of rows per page load, and it gets slower
every day the game runs. From `daily_active_users` it's 30 rows, always. Stage 2
paid the cost **once, at write time**. Every dashboard load is then cheap, and
dashboards get loaded far more often than events get written per metric. This is
the payoff of the "compute at write time vs read time" tradeoff.

Even "players online right now" avoids `events`. It counts **open sessions**
(`player_sessions` where `left_at IS NULL`) on servers heard from in the last 5
minutes. That's the same rule the worker's players-online job uses, applied to
this instant, and it's served by the partial index on open sessions.

### A separate service, not more routes on the ingestion API
> "Why didn't you just add these endpoints to your existing API?"

The two have opposite jobs:
- **Ingestion API:** write-only and latency-critical. Every game server in the
  world talks to it, and it never touches Postgres.
- **Dashboard API:** read-only, a handful of users, and it queries Postgres.

If they shared a process, a slow chart query or 50 open dashboards would take
event-loop time and connections from ingestion. Separate, each scales, deploys
and fails on its own. Also, a bug in the dashboard can't take down data collection.

### Server-Sent Events, not WebSockets or polling
> "How do live updates work? Why SSE?"

Three options for "the server has something new":

| | How | Fits here? |
|---|---|---|
| **Polling** | browser asks every N seconds | Wasteful for a feed; adds up to N seconds of delay |
| **WebSocket** | two-way connection, its own protocol after an HTTP upgrade | Two-way isn't needed: the browser never sends anything |
| **SSE** | one long HTTP response the server keeps writing to | One-way, which is exactly this |

SSE wins because the data only flows **server → browser**. It's plain HTTP,
so proxies, auth headers and dev tools all just work. The browser's `EventSource`
**reconnects by itself** after a drop. The wire format is just text:

```
event: game_event
data: {"event_id":"…","type":"purchase","properties":{"product_id":"pet_egg","robux":100}}

```

The charts still **poll** (every 15s for players online, 60s for daily charts).
They read rollups that change at most every 15 seconds, so pushing them would buy nothing.
Use push where data changes continuously (the feed, online now) and polling where
it changes on a schedule.

### Where the live feed comes from: tailing the stream with XREAD
> "The dashboard reads rollups, so where does the live event feed come from?"

The feed is the one view that wants individual events. It can't come from
rollups, and polling the raw `events` table would break the rule above. Three
options:

1. **Poll `events`** (`ORDER BY stored_at DESC LIMIT 50` every second). It puts
   load on the raw table, which is exactly what we're avoiding.
2. **Postgres `LISTEN/NOTIFY` from the worker.** It adds work inside the worker's
   write transaction, and payloads are capped at 8000 bytes.
3. **Read the Redis stream the events are already in.** ✅

The stream is already a log of recent events. The dashboard API reads it with
**plain `XREAD`, not through the consumer group**
([`liveFeed.ts`](../packages/dashboard-api/src/liveFeed.ts)). This is the key
detail:
- A consumer group **splits** entries between its members. If the dashboard
  joined `bx-workers`, it would steal events from the workers, and they'd never
  be stored.
- Plain `XREAD` is a **read-only cursor**. It leaves no pending entries and
  acknowledges nothing, so the workers can't tell it exists. There's a test
  proving the group's lag and pending counts are untouched.

This is fan-out: Redis Streams support both "share the work" (groups) and
"everyone sees everything" (plain reads) on the same stream, which is a big reason to choose Streams over a plain list.

**A tradeoff to state honestly:** the feed shows events **as accepted**, before the worker
stores them. Measured: an event reaches the browser in **~6ms** after the POST
returns, and is stored in Postgres in ~33ms (p95 ~78ms). So in rare cases the feed
can show something that later gets dead-lettered. For a "what's happening now" view that's
fine, and the panel says so.

### One reader, many viewers
The dashboard API runs **one** XREAD loop per process, however many browsers are
connected. Each event is handed in memory to the listeners for its game. The
headline numbers work the same way: [`OverviewCache`](../packages/dashboard-api/src/overviewCache.ts)
shares one query result per game for a second, so 50 people watching one game cost
one query, not 50. It caches the *promise*, so simultaneous requests also share
the query in flight. Cost grows with **games being watched**, not viewers.

### Live connections need care
[`routes/live.ts`](../packages/dashboard-api/src/routes/live.ts) handles cases a
normal request never has:
- **On connect:** it replays the game's last 50 events, so the feed isn't blank.
  That means a *reconnect* replays events the browser already has, so the client
  removes duplicates by `event_id`. That's at-least-once plus dedupe again, the
  same idea as the worker's `ON CONFLICT`.
- **Slow clients:** if a browser stops reading and more than 1 MiB piles up
  unsent, it's dropped rather than buffered forever (backpressure).
- **Shutdown:** an SSE response never ends by itself, so `app.close()` would wait
  forever. A `preClose` hook ends every stream first; `EventSource` reconnects
  once the server is back. There's a test for it.
- **The client goes away:** the response's `close` event unsubscribes it and
  stops its timer, so nothing leaks.
- **The overview is pushed every 5s**, which also keeps idle proxies from closing
  the connection.

### Dates and time zones (a classic bug, avoided on purpose)
A *day* in the rollups is a UTC calendar date. A *minute* is an instant.
- `node-postgres` turns a `date` column into a JS `Date` at **local midnight**.
  `new Date("2026-03-10")` is UTC midnight, which displays as **Mar 9** for anyone
  west of London. So days travel as `'YYYY-MM-DD'` text (`to_char` in SQL), and
  the browser formats them by hand ([`format.ts`](../packages/dashboard/src/format.ts)).
- Minutes are epoch ms and **are** shown in the viewer's time zone, because an
  instant is the same everywhere.
- The UI labels daily charts "(UTC)", so "today" isn't a mystery to someone in Toronto at 9pm.

Two related details:
- **`bigint` arrives as a string** in node-postgres (JS numbers lose precision
  above 2^53). Counts and robux are cast to `float8` in SQL; they'll never get
  near 2^53.
- **Gap filling:** a rollup has *no row* for a quiet minute or day, but a chart
  needs a 0 drawn there. Each series `LEFT JOIN`s onto `generate_series`, so
  there's one point per minute/day with 0s filled in.

### The current minute is left out
The players-online job runs every 15 seconds. Including the current minute meant
the chart's last point was often 0 (not computed yet), a fake cliff. I spotted
it in the browser. Since the current minute isn't over anyway, the series ends at
the last complete minute. The live "Players online" number covers the present.

### Basic auth, optional
Set `DASHBOARD_PASSWORD` and every route except `/health` needs HTTP Basic auth.
The browser shows its own login prompt, then sends the header on every request,
**including `EventSource`**, which can't set custom headers. That rules out the
usual `Authorization: Bearer` token. It's a single shared password, compared in
constant time, and only safe over HTTPS. Enough to keep a deployed demo private
(Stage 5). Real multi-user auth (accounts, per-game access) is a bigger feature,
and it's out of scope.

### The seed script goes through the real write path
`npm run seed-demo -- demo-game` makes 14 days of believable history: an evening
peak, new players every day, about 40% back on day 1 and 15% on day 7, and
purchases. It **doesn't insert rollup rows by hand**. It makes ordinary events,
stores them with the worker's own `storeEvents`, and runs the rollup job, so the
charts show what the pipeline really produces. Its randomness is seeded from the
game id, so event_ids come out the same each run. Running it twice adds nothing
("5493 events generated, 0 new"): idempotency again.

## Running it

```powershell
npm.cmd run infra:up
npm.cmd run seed-demo -- demo-game      # optional: two weeks of history
npm.cmd run dev:api                     # terminal 1  :8080
npm.cmd run dev:worker                  # terminal 2
npm.cmd run dev:dashboard-api           # terminal 3  :8082
npm.cmd run dev:dashboard               # terminal 4  http://localhost:5180
```

Then play the example place in Studio (Stage 3), or send events to `:8080` any
other way, and watch the feed.

## What I verified (not just assumed)
| Check                                   | Result                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------- |
| Tests                                   | 76 pass: 14 dashboard API (series, gaps, auth, SSE, shutdown, consumer group untouched), 5 formatting |
| End to end in a browser                 | Simulated servers POSTing to the ingestion API: the feed updated within a second, online now and the chart rose with players |
| POST → browser feed                     | p50 6.5ms, p95 7.9ms (local)                                          |
| POST → stored in Postgres               | p50 33ms, p95 78ms (local)                                            |
| Seed run twice                          | Second run: 0 new events                                              |
| Phone width, light and dark             | Single column, no horizontal scroll                                   |

## Things to be ready to discuss
- **Scaling the live feed.** Every dashboard API process reads *every* event of
  *every* game, then filters. With thousands of busy games that wastes work.
  Options: a stream per game (`bx:events:{game}`), or Redis Pub/Sub channels per
  game that the worker publishes to. Fine for now, and easy to change behind `LiveFeed`.
- **Many dashboard API instances behind a load balancer.** Works without changes.
  Each instance reads the stream independently, and SSE connections are
  long-lived, so they stick to one instance anyway.
- **Bundle size.** The production build is 183 KB gzipped, mostly Recharts. It
  could be code-split, but for an internal dashboard it isn't worth the complexity.
- **What "players online" means.** "Distinct players in a session at any point in
  that minute", not an instantaneous sample. A player who leaves at :10 and one
  who joins at :50 both count. Know your metric's definition, and the panel states it.
