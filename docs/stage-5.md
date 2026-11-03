# Stage 5: Load test, CI, deploy, polish

**Goal:** find out how much the system can actually handle, with real numbers
and an explanation of what limits it. Then make it shippable: containers, CI on
every push, a deployment path, and a README that sells it.

## The load generator

[`packages/loadgen`](../packages/loadgen) simulates N game servers × M players.
Each simulated server behaves like the Luau SDK
([`sim.ts`](../packages/loadgen/src/sim.ts)):
- It buffers events and sends a batch at 50 events or every 10 seconds.
- It keeps **one request in flight** per server.
- It sends gzip bodies.
- On a `429`/`503` it keeps the same batch and backs off.
- The event mix is realistic: mostly custom events, about 1% purchases, and
  players leaving and being replaced.

It steps through target rates and prints a Markdown table per run: accepted
ev/s, ingest p50/p95/p99, errors, stream backlog, store lag, and whether the rate
was **sustained**.

### Measurement traps I hit (good interview stories)

**1. Coordinated omission: open loop vs closed loop.**
A naive load generator sends the next request when the last one returns (a
*closed loop*). If the server slows down, the generator slows down with it. The
offered load quietly drops, and the latency numbers look better than reality.
Ours generates events on a **clock** (an *open loop*). If the API is slow, events
pile up in the simulated server's buffer, as they would in a real game, and that
shows in the results.

**2. The thundering herd I created myself.**
The first run showed **104ms p50** at only 11 requests/s. That's absurd for an
API that answers a single request in 5ms. The server's own logged response
times agreed, so it wasn't the client. The cause: all 200 simulated servers
started at the same instant and filled their batches at the same rate, so they
sent **in the same millisecond, every time**. The API handled them one after
another, and the last waited for all the others. Real game servers started at
different times. Giving each simulated server a random starting point in its
batch and flush cycle brought p50 to **7ms**. Lesson: synchronized clients are a
real production problem too. It's why the SDK's retry backoff has jitter.

**3. Measuring the environment instead of the code.**
Run on Windows against Docker Desktop, one worker stored only ~1,300 ev/s. I
timed every SQL statement in the store transaction and got ~50ms each, but
`EXPLAIN ANALYZE` said Postgres executed them in **~2ms**. The rest was the
**Docker Desktop port proxy** between Windows and the Linux VM: each of the
transaction's 9 statements paid it. Inside the Docker network, the same worker
stores **~4,000 ev/s**, 3× faster. So every published number is measured with
the load generator *inside* Docker too
(`docker compose --profile bench run --rm loadgen ...`).

**4. Defining "sustained" honestly.**
"The API returned 202" isn't enough: the API can accept far more than the workers
can store, and the backlog just grows until backpressure kicks in. A rate counts as
**sustained** only if:
- the API accepted ≥97% of what was offered, and
- the stream backlog **didn't grow** over the 30-second step (grew by < 2% of the
  events added).

My first definition compared the end backlog to a fixed number. It also counted
the events legitimately sitting in each server's partial batch, so even an easy
rate came out "not sustained". The definition matters as much as the measurement.

## Results

Every service in Docker on one machine: AMD Ryzen 7 8845HS (8C/16T), Docker
Desktop (16 CPUs, 8 GB), Postgres 16, Redis 7 (AOF everysec). 200 servers × 20
players, 30s per step after a 5s warm-up. The load generator shares the CPU with
everything it's testing, so these numbers are conservative.

| Workers | Max sustained | Ingest p50 | p95 | p99 | Stored after (p50 / p95) |
| ------: | ------------: | ---------: | --: | --: | -----------------------: |
| 1       | **4,000** ev/s | 7.3 ms    | 14.9 ms | 20.4 ms | 0.76 s / 1.09 s |
| 2       | **7,000** ev/s | 9.0 ms    | 27.8 ms | 42.4 ms | 0.68 s / 1.20 s |
| 4       | **8,000** ev/s | 13.9 ms   | 120 ms  | 148 ms  | 0.14 s / 1.98 s |

One step past each limit (5,000 / 8,500 / 10,000 ev/s), the API still accepted
everything, but the backlog grew steadily and store lag climbed into seconds. The
queue absorbed the excess, which is exactly what it's for.

**Ingestion alone** (workers stopped, 400 servers):

| Offered | Accepted | p50 | p95 |
| ------: | -------: | --: | --: |
| 10,000 ev/s | 10,020 | 31 ms | 156 ms |
| 20,000 ev/s | 20,057 | 73 ms | 141 ms |
| 30,000 ev/s | 30,114 | 128 ms | 214 ms |

So one Node process accepts **30k ev/s**, with latency rising as its single thread
saturates. Ingestion has about **4× headroom** over storage. With the workers
stopped, the stream reached the 1M-entry backpressure limit in an earlier run, and
the API returned `503`s instead of growing Redis without limit, as designed in Stage 1.

### Why 4 workers ≈ 2 workers: hot-row contention
> "Your workers scale horizontally. Why doesn't 4× workers give 4× throughput?"

During a 4-worker run at 10k ev/s I sampled `pg_stat_activity`:

```
54  CPU:running
15  Lock:transactionid     <- waiting for another transaction to commit
 4  IO:WALSync
```

About 20% of the time, sessions were waiting on another worker's transaction.
Every batch updates the **same few rows**: this game's `daily_active_users` and
`revenue_daily` for today, plus its `game_servers` rows. A row lock is held until
COMMIT, which includes flushing the WAL to disk. So the workers' transactions queue
up behind each other on those rows, and adding workers mostly adds waiting. That's
a **hot row**, a classic limit on write-heavy counters.

With many games instead of one, the load spreads over many rows and this mostly
disappears. Our benchmark is the worst case: one very popular game. Ways to go further:
- **Partition by game:** route each game to one worker (hash `game_id` to one of
  N streams), so no two workers ever touch the same game's rollups. This is how
  Kafka partitions keep per-key ordering and avoid contention.
- **Pre-aggregate in memory, flush periodically:** accumulate "+3 purchases, +450
  robux" per (game, day) and apply it once a second. Far fewer hot-row updates,
  but the increments live in memory until flushed, so they must be committed
  together with the acks to stay exactly-once.
- **Bigger batches:** fewer transactions per event means fewer lock handoffs.
  It raises latency a little.

I didn't build these: at this project's scale they're premature, and the
measurement plus the explanation is the useful result.

## Containers

**One image for every service** ([Dockerfile](../Dockerfile)). The API, worker,
dashboard, migrations and loadgen differ only in their start command:
- One build, one artifact to test.
- The services can never run different versions of the shared event schemas.

The cost is size (691 MB, because it includes dev tooling); a multi-stage build
could trim that.

Details worth knowing:
- **Layer caching:** `package.json` files and the lockfile are copied and
  installed *before* the source, so a code change doesn't reinstall dependencies.
- **`node --import tsx …` as PID 1:** with `npx tsx`, Docker's `SIGTERM` would hit
  the npx wrapper. Our graceful-shutdown handlers wouldn't run reliably, and the
  container would be killed mid-batch after the timeout.
- **`USER node`:** don't run as root inside the container.
- **The dashboard API serves the built React app** in production. One origin
  means no CORS, Basic auth covers the page and its API, and there's one less
  service to deploy.
- **`PORT` fallback:** hosting platforms say which port to listen on in `PORT`.
- **Compose profiles:** `npm run infra:up` still starts only Postgres and Redis
  for development. `--profile app` adds the application, and `--profile bench`
  adds the load generator. A `migrate` service runs once, and the others wait for
  it to complete successfully (`service_completed_successfully`).

Fail-fast config validation earned its keep here. The first container boot
crashed immediately with *"DASHBOARD_PASSWORD: expected ≥8 characters"*, because
compose passes an empty string for an unset variable. A clear error at boot beats
a dashboard silently protected by an empty password. Empty now means "no password".

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to
`main` and every pull request:
- **check:** `npm ci`, lint, typecheck, the full test suite, and the dashboard build.
  Postgres and Redis run as **service containers** on the same ports as
  docker-compose, so the tests run unchanged.
- **docker:** the image must build.
- **`concurrency`:** a new push to the same branch cancels the old run.

Before pushing, I ran the same lint, typecheck and tests on **Linux** inside the
built image against the compose databases: all 81 pass. That catches the usual
Windows-to-Linux surprises (path separators, case-sensitive imports, line
endings) without needing GitHub.

The Luau specs need Roblox Studio, so CI can't run them. They're run by hand
(Stage 3).

## Deploying

See [deploy.md](deploy.md). All the free options run the same `docker compose` stack:
- **Laptop + Cloudflare quick tunnel ($0):** a public HTTPS address for testing
  with real Roblox servers or demoing in an interview. Up only while the laptop is.
- **Student credits or Oracle Cloud's free VM ($0):** always on. You run Docker
  yourself, with Caddy for HTTPS.
- **Railway (~$5–10/mo, paid):** managed Postgres + Redis, deploys the Dockerfile from GitHub.

Deployment is what lets real Roblox servers reach the API: they can't call `localhost`.

> "How would you deploy this?"

- Three stateless services from one image, plus managed Postgres and Redis.
- Migrations run as a pre-deploy step, not at app startup. Two replicas starting
  at once would otherwise race to migrate.
- Workers scale by adding replicas; each gets a unique consumer name from its hostname.
- The dashboard gets a password, and only the ingest API and dashboard are public.

## Polish along the way

- **Feed layout bug, found while taking the README screenshot.** With 100 events
  in the live feed, the feed's height stretched the grid rows, and the
  players-online panel grew huge and empty. `contain: size` stops the feed's
  content from sizing the grid; the charts set the height and the feed scrolls.
- **Static serving and `PORT`** for deployment, covered by a new test.

## What I verified
| Check | Result |
|---|---|
| Tests | 81 pass on Windows and on Linux (inside the image) |
| Full stack in Docker | migrate → api, worker, dashboard healthy; dashboard served on :8082 |
| README quick start commands | `create-game` through the compose `migrate` service works as written |
| Benchmarks | Above; raw tables printed by loadgen |
| Screenshot | Real stack, seeded history, live simulated traffic |

## Things to be ready to discuss
- **Single machine.** The load generator, API, workers, Postgres and Redis all
  shared one laptop. On separate machines every number would go up, and the
  *ratios* (ingest ≫ storage, hot-row contention) are the transferable insight.
- **Latency vs throughput.** p95 ingest latency at 4 workers (120ms) is worse than
  at 1 worker (15ms), with the same API. The 4 workers and a busy Postgres compete
  for the same CPU. Colocating services hides costs like this.
- **Why p50 *and* p95/p99.** The median says what a typical request sees; the tail
  says what the unlucky ones see. With 200 servers each sending 6+ requests a
  minute, "1 in 100" happens every second.
- **What I'd measure next:** many games at once (should remove most hot-row
  waiting), the worker batch size (500 → 2000), and a separate box for Postgres.
