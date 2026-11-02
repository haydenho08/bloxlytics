# GamePulse

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
| `packages/sdk-luau` | Stage 3                                                         |
| `packages/dashboard`| Stage 4                                                         |
| `packages/loadgen`  | Stage 5                                                         |
