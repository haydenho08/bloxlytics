# Bloxlytics

Real-time analytics for Roblox games: a Luau SDK batches gameplay events from
game servers, an ingestion API queues them in Redis Streams, workers store them
in Postgres and build rollups, and a React dashboard shows them live.

> Work in progress, built in stages. See [docs/](docs/) for the walkthrough of each stage.

```
Roblox game server (Luau SDK) -> HTTPS batch -> ingestion API -> Redis Stream
  -> worker(s) -> Postgres (raw events + rollups) -> dashboard API -> React dashboard
```

## Quick start (Windows / PowerShell)

Requires Node 22+ and Docker Desktop.

```powershell
npm install
Copy-Item .env.example .env
npm run infra:up            # Postgres 16 on :5433, Redis 7 on :6380
npm run migrate
npm run create-game -- my-obby "My Obby"   # prints an API key once
npm run dev:api             # http://127.0.0.1:8080
npm run dev:worker          # in a second terminal: stream -> Postgres
npm run seed-demo -- demo-game             # optional: two weeks of demo history
npm run dev:dashboard-api   # third terminal: http://127.0.0.1:8082
npm run dev:dashboard       # fourth terminal: open http://localhost:5180
npm test
```

If PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled`,
use `npm.cmd` in place of `npm`, or run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

## Layout

| Package             | What it is                                                     |
| ------------------- | -------------------------------------------------------------- |
| `packages/shared`   | Event schemas (zod) and stream format, shared by API and worker |
| `packages/db`       | SQL migrations (events, rollups), migration runner, API keys    |
| `packages/api`      | Fastify ingestion API                                           |
| `packages/worker`   | Consumer-group worker: stores events, builds rollups            |
| `packages/sdk-luau` | Luau SDK for Roblox game servers (Rojo); see its README         |
| `packages/dashboard-api` | Read-only Fastify API over the rollups, live SSE stream    |
| `packages/dashboard`| React + Vite + Recharts dashboard                               |
| `packages/loadgen`  | Stage 5                                                         |
