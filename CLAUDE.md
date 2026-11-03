# Bloxlytics: project plan and working rules

## Who and why
Hayden is a first-year Software Engineering student at York. Bloxlytics is a
real-time analytics pipeline for Roblox games: his second resume project, for
Summer 2027 SWE internships. His first project, StudyFlow, is a full-stack CRUD
app, so this one shows backend and systems skills: event ingestion, queues,
idempotency, aggregation and load testing.

Hayden must be able to explain every design choice in interviews, so we build in
stages. **After each stage, stop and walk him through what was built and why, like
a professor would. Point out the concepts and the interview questions they
answer. Don't start the next stage until he says so.**

## Current status
- [x] Stage 1: infra + ingestion API (see docs/stage-1.md)
- [x] Stage 2: worker + storage (see docs/stage-2.md)
- [x] Stage 3: Luau SDK (see docs/stage-3.md)
- [x] Stage 4: dashboard (see docs/stage-4.md)
- [x] Stage 5: load test + polish (see docs/stage-5.md, docs/deploy.md)

Update this checklist when a stage is finished.

## Environment
Windows, PowerShell, VS Code, Docker Desktop, Roblox Studio.
- Host ports: Postgres **5433**, Redis **6380** (5432 is taken by another project).
  Vite runs on **5180** because StudyFlow's Vite uses 5173.
- Hayden's PowerShell blocks `npm.ps1`. Tell him to use `npm.cmd` in commands he runs himself.
- Test database `bloxlytics_test`, test Redis db `/1`. Dev uses db `/0`.
- Studio's HttpService can reach `localhost` (verified), so Studio tests need no
  tunnel. Rojo isn't installed yet (`rokit.toml` pins it); without it, sync the
  SDK into Studio over the Studio MCP and run the specs in a Play server.

## Tech stack
- Ingestion API + workers: TypeScript, Node.js, Fastify, zod for validation
- Queue: Redis Streams with consumer groups
- Database: PostgreSQL 16
- Infra: docker-compose for Postgres + Redis locally
- In-game SDK: Luau, managed with Rojo so the Luau code lives in the git repo
- Dashboard: React + TypeScript (Vite) + Recharts, live updates over WebSocket or Server-Sent Events
- Tests: Vitest; integration tests against real Postgres and Redis in Docker

## How it works
Roblox game server (Luau SDK) → batched HTTPS POST → ingestion API → Redis Stream
→ worker(s) → Postgres (raw events + rollup tables) → dashboard API → React dashboard

Event types for v1: player_join, player_leave, purchase, custom (name + JSON
properties). Every event has: event_id (a GUID made in Luau), game_id, server_id,
player_id, type, timestamp (epoch ms), properties. The schemas live in
`packages/shared/src/events.ts`.

## Stages
1. **Infra + ingestion API.** Monorepo (packages for api, worker, dashboard,
   sdk-luau, loadgen), docker-compose, .env.example, .gitignore. POST /v1/events
   takes a batch of up to 100 events. Per-game API key in a header (store only a
   hash). Validate with zod. Rate-limit per game. Add events to a Redis Stream and
   return 202 quickly; the API never writes to Postgres directly. Health endpoint. Tests.
2. **Worker + storage.** A consumer group reads the stream and inserts raw events
   into Postgres. Idempotent: event_id is unique, ON CONFLICT DO NOTHING,
   acknowledge messages only after they're committed. Retry failures; move events
   that fail repeatedly to a dead-letter stream. Rollups: players online per
   minute, daily active users, day-1 and day-7 retention, purchase revenue per
   day. Database migrations. Tests, including one proving that sending the same
   event twice is only counted once.
   - Carry-over from Stage 1: the API's backpressure check uses XLEN, so the worker
     must trim entries every consumer has acknowledged, or the limit trips with an
     empty backlog.
3. **Luau SDK.** A server-side ModuleScript (never a client script) that buffers
   events and sends a batch every 10 seconds or every 50 events, whichever comes
   first. Retry with exponential backoff (don't retry 4xx except 429). Cap the
   buffer size and drop the oldest events if it fills. Flush on game:BindToClose.
   Respect Roblox's HttpService per-server request limits. Keep the API key out of
   the place file (experience secrets via HttpService:GetSecret if available).
   A small example place to test in Studio. If Studio can't reach localhost, set
   up a tunnel and explain how. Document how to enable HttpService. Consider gzip
   request bodies.
   - Carry-over from Stage 2: the worker treats a server that sends nothing for 5
     minutes as crashed and ends its sessions, so the SDK must send something
     (a heartbeat) every minute or so even when idle. It should also send
     player_join for players already in the server when the SDK starts.
4. **Dashboard.** Choose a game, then show live players online, daily active
   users, a day-1/day-7 retention chart, revenue, and a live event feed. The
   dashboard API reads from the rollup tables, not raw events.
5. **Load test + polish.** A loadgen script that simulates N game servers × M
   players sending realistic events. Measure the highest sustained events/sec and
   p50/p95 ingest latency; put the numbers in the README. GitHub Actions CI running
   lint, typecheck and tests. Deploy (suggest free or cheap hosting that supports
   Postgres + Redis). Resume-ready README with a Mermaid architecture diagram,
   setup steps, benchmark results and screenshots.

## Engineering standards
- TypeScript strict mode. Shared event types/schemas between the API and the worker.
- Structured logging. Graceful shutdown (finish in-flight work before exiting).
- Index the raw events table for the queries we actually run, and explain the choice.
- Explain the tradeoffs where they come up: why a queue instead of writing straight
  to the DB, at-least-once vs exactly-once delivery, and when to compute rollups at
  write time vs read time.

## Workflow
- Actually run things: start Docker, install dependencies, run migrations, run
  tests until they pass, and start the services to check they work end to end.
- Put a short teaching walkthrough for each stage in `docs/stage-N.md`.
- Commands: `npm run infra:up`, `npm run migrate`, `npm run create-game -- <id> "Name"`,
  `npm run dev:api`, `npm run dev:worker`, `npm run dev:dashboard-api` (:8082),
  `npm run dev:dashboard` (:5180), `npm run seed-demo -- <id>`, `npm test`, `npm run lint`,
  `npm run typecheck`, `npm run loadgen -- --steps ...`.
- Full stack in Docker: `docker compose --profile app up --build -d` (api :8080,
  dashboard :8082). Benchmarks run loadgen inside Docker
  (`docker compose --profile bench run --rm loadgen ...`): from Windows, the Docker
  Desktop port proxy dominates the numbers.
- Not deployed yet, and no GitHub remote yet: ask Hayden before creating either.

## Git rules
- Commit as **Hayden Ho <hydnho@gmail.com>** (set with `git config` in this repo,
  already done) so commits count on his GitHub contribution graph.
- **Do NOT add Co-Authored-By or any Claude attribution lines to commit messages.**
- Make small, meaningful commits.
- GitHub username: haydenho08. **Ask before creating or pushing to a remote repo.**
