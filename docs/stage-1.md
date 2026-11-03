# Stage 1: Infra + ingestion API

**Goal:** accept batches of game events over HTTP, decide quickly whether each
batch is acceptable, and put it on a durable queue. Answer `202 Accepted` fast.
Nothing gets stored in Postgres or aggregated yet. That's Stage 2.

## The request path

```
POST /v1/events  (X-API-Key: bx_...)
  1. Auth         key -> SHA-256 -> api_keys lookup (cached)       401
  2. Validate     zod: 1-100 events, typed per event type          400
  3. Ownership    every event's game_id == the key's game          403
  4. Rate limit   token bucket in Redis, cost = number of events   429 + Retry-After
  5. Enqueue      Lua: if stream too long, refuse; else XADD all   503 + Retry-After
  6. 202 { accepted: n }
Redis or Postgres down at any step                                 503 + Retry-After
```

The order matters. The cheap checks that reject the most junk come first.
Rate limiting comes after validation so the cost is the real number of events.
The only write, the enqueue, comes last.

Code: [`packages/api/src/routes/events.ts`](../packages/api/src/routes/events.ts).

## Repo layout: a monorepo with npm workspaces

`shared` holds the zod schemas. The API validates with them now, and the worker
will read the same `GameEvent` type in Stage 2. If the two sides disagreed about
an event's shape, the bug would be silent. With shared code it's a compile error.

`shared` and `db` export their TypeScript source directly (`"exports": "./src/index.ts"`).
There's no build step between packages: `tsx` runs the code, `tsc --noEmit` type-checks
it, and Stage 5 will bundle each service for deployment.

## Design decisions (and the interview questions they answer)

### Why a queue instead of writing straight to the database?
> "Why put Redis between the API and Postgres?"

- **Separate fast from slow.** Game servers need a fast, predictable answer.
  Database writes, index updates and rollups are slower and spikier. With the
  queue, a slow database makes the backlog grow. It doesn't make game servers wait.
- **Absorb bursts.** A popular game's Friday evening spike is soaked up by the
  stream, and workers drain it at their own pace.
- **Scale each side on its own.** More API instances for more traffic, more workers
  for more processing.
- **Survive outages.** If Postgres is down for a minute, events pile up in Redis
  instead of being lost or bounced.

Cost: one more moving part, and data is *eventually* consistent. The dashboard
lags ingestion by however long the backlog is.

### Why Redis Streams (vs a list, pub/sub, or Kafka)?
- Pub/sub drops messages when no consumer is connected, so it can't be our queue.
- A Redis list (`LPUSH`/`BRPOP`) loses a message if a worker crashes after
  popping it.
- Streams have **consumer groups**: each message goes to one worker in the group.
  A worker must **acknowledge** (`XACK`) a message. Unacked messages stay in a
  pending list and can be reclaimed if their worker dies. That's what gives us
  at-least-once delivery in Stage 2.
- Kafka does this at much bigger scale but is heavy to run. Streams give us the
  same ideas (an append-only log, consumer groups, offsets) in the Redis we
  already need for rate limiting.

**Durability:** the stream is our queue, so Redis runs with AOF persistence
(`appendfsync everysec`). A crash loses at most about one second of writes.
`always` would lose nothing but fsync on every write, which is slower. Say this
out loud in an interview: it's a deliberate trade, not an oversight.

### Why 202 and not 200 or 201?
`202 Accepted` means "received, will be processed, not done yet". That's exactly
what happened. `201 Created` would claim the events are stored, which they aren't yet.

### One stream entry per event, written atomically per batch
Each event becomes its own stream entry, so the worker can retry, dead-letter
and acknowledge events one by one. The whole batch is added in **one Lua script**,
which Redis runs as a single atomic step:
- One network round trip for up to 100 `XADD`s.
- **All or nothing.** A batch is never half-enqueued. If it were, a client retry
  would duplicate the first half.
- The backpressure check (`XLEN`) and the add happen with no gap between them,
  so no other request can slip in between.

### Backpressure / load shedding (503 `queue_full`)
If workers fall behind (or stop), the stream would grow until Redis runs out of
memory and *everything* fails. Instead, once `STREAM_MAX_PENDING` entries are
waiting, we refuse new batches with `503 + Retry-After`. The SDK keeps them in
its buffer and retries. Failing a little, early, beats failing completely, later.

Why not just trim the stream with `XADD MAXLEN`? Trimming deletes the *oldest*
entries, which may not be processed yet. That's silent data loss.

> Known gap for Stage 2: `XLEN` counts every entry, processed or not. The worker
> must trim entries that all consumers have acknowledged, or the limit will trip
> even with an empty backlog.

### API keys: per game, stored only as a hash
> "How do you store API keys?" / "Why SHA-256 and not bcrypt?"

- A key is `bx_` + 32 random bytes (256 bits) in base64url. It's shown once by
  `create-game`, and only `sha256(key)` goes in the database. A database leak
  doesn't leak usable keys.
- **SHA-256, not bcrypt.** bcrypt is slow *on purpose* because passwords have low
  entropy and can be guessed. A 256-bit random key can't be brute-forced however
  fast the hash is, and we hash on every request, so slowness would only cost us.
- **Lookup by hash** (unique index), so no secret is ever compared character by
  character. That removes the timing-attack worry.
- **Separate `api_keys` table**, so a game can have several keys. To rotate:
  issue a new key, deploy it, then set `revoked_at` on the old one.
- `key_prefix` (first 10 characters) lets a UI tell keys apart without storing them.
- The `bx_` prefix makes leaked keys easy to spot (secret scanners look for
  prefixes like this) and lets us reject malformed keys without touching the database.

**Cache:** auth results are kept in memory for 60s (10s for unknown keys, so
bad-key floods don't hammer Postgres). Trade-off: a revoked key keeps working
for up to 60s. That's fine for analytics, not for a bank.

The API *reads* Postgres for keys but never *writes* to it. Events only go to Redis.

### Rate limiting: token bucket, per game, in Redis
> "Design a rate limiter."

- **Token bucket.** Each game has `burst` tokens that refill at `rate`/sec. A
  batch costs one token per event. It allows short bursts (a server flushing
  after a hiccup) while capping the sustained rate. A fixed window
  ("1000 per minute") lets twice the limit through at window edges (end of one
  minute plus start of the next) and has no burst control.
- **Per event, not per request.** Otherwise one 100-event batch would cost the
  same as one 1-event batch.
- **In Redis, not in memory.** With 3 API instances, in-memory limits would allow
  3x the rate. The test "is shared across API instances" proves this.
- **Atomic Lua + Redis's own clock (`TIME`).** Reading and updating the bucket is
  one step, so two requests can't both spend the last tokens. Using Redis's
  clock means API servers with drifting clocks can't disagree about the refill.
- `PEXPIRE` cleans up idle buckets. A full bucket and a missing one behave the same.
- **429 + `Retry-After`** tells the SDK exactly how long to wait.

### Validation with zod: strict where it matters
- `event_id` must be a GUID and is **lower-cased**. Otherwise `ABC...` and
  `abc...` would get past Stage 2's unique constraint as two different events.
- `timestamp` is epoch **milliseconds**. It's rejected if more than 5 minutes in
  the future (clock skew) or more than 7 days old. This also catches the classic
  bug of sending seconds instead of milliseconds, which reads as 1970.
- `player_id` must be an integer at most 2^53 (Roblox UserIds already exceed 2^31).
- `purchase` requires integer, non-negative `robux` and a `product_id`, because
  revenue rollups depend on them. Extra fields are kept.
- `properties` must be JSON and at most 8 KiB. One bad event can't bloat a row.
- Unknown top-level fields are dropped, not rejected. Newer SDKs can send new
  fields to an older API without breaking (forward compatibility).
- **All-or-nothing batches:** one invalid event gets the batch a 400 that names
  the bad event (`events.1.event_id`). Simpler than partial acceptance, but the
  SDK must *not* retry 4xx errors (except 429), or a bad event will block its
  buffer. That rule goes into the Stage 3 SDK.

### Failing fast when Redis is down
By default, ioredis queues commands while disconnected and retries them, so
every request would *hang*. We set `enableOfflineQueue: false` and
`maxRetriesPerRequest: 1`, so requests get a **503 within milliseconds** and the
SDK backs off. The test "answers 503 quickly when Redis is unreachable" asserts
under 1 second.

### Health vs readiness
- `GET /health` (**liveness**): is the process alive? It never checks
  dependencies. A Redis blip shouldn't make Kubernetes restart every healthy
  API process.
- `GET /ready` (**readiness**): should traffic be sent here? It checks Redis and
  Postgres (1s timeout each), and returns 503 while shutting down so a load
  balancer drains us first.

### Graceful shutdown
On SIGINT/SIGTERM: mark not-ready, then `app.close()`. That stops accepting
connections and *waits for in-flight requests to finish*. Only after that do we
close Redis and Postgres, since those requests still need them. A 10s timeout
forces an exit if something hangs. Without this, a deploy would cut off requests
mid-enqueue, and the SDK would see errors (and retry, creating duplicates).

On Windows, Ctrl+C sends SIGINT to Node. SIGTERM is what Docker/Kubernetes send.

### Config validated at startup, dependencies injected
`config.ts` parses env vars with zod. A typo crashes at boot with a clear message,
not on the first request. `buildApp()` receives its Redis, Postgres pool and
config instead of creating them. That's what lets tests pass a tiny rate limit,
a test database, or a Redis that's deliberately unreachable.

### Logging
Fastify uses pino: structured JSON logs (one object per line, easy to search),
pretty-printed only in a dev terminal. Every request has an id (`x-request-id`,
taken from the caller if they send one) that's echoed in the response. The API
key header is **redacted**.

## Tests

`npm test` runs 29 tests against the real Postgres and Redis from docker-compose,
using a separate database (`bloxlytics_test`) and Redis db `/1`.
`fastify.inject()` sends fake HTTP requests straight into the app with no network.

| Behaviour                          | Test                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Valid batch -> 202 + on stream     | events are normalised and stamped with `received_at`                                |
| Auth                               | missing/unknown -> 401, revoked -> 401, plaintext never stored                      |
| Cross-game write                   | -> 403, nothing enqueued                                                            |
| Validation                         | empty / 101 / bad event (with path) / purchase without robux / malformed JSON       |
| Rate limit                         | 429 + Retry-After; separate per game; shared across two API instances               |
| Backpressure                       | 503, and no partial write                                                           |
| Redis down                         | 503 in under 1s; `/ready` -> 503                                                    |

Why real Postgres and Redis instead of mocks? The interesting logic here *is*
the Lua scripts and SQL. A mock would test the mock.

## Manual check (what I ran)

`create-game`, then the API on :8080, then real HTTP: 202 / 401 / 400 as
expected, and entries visible with `XRANGE bx:events`. 50 back-to-back batches
of 50 events hit the default limit (500/s, burst 2000): 8 batches got 429.
That's the limiter doing its job. Latency was about 5ms p50 on localhost
(rough; Stage 5 measures it properly).

## Things to be ready to discuss
- At-least-once: if the API enqueues but the response is lost, the SDK retries,
  so **duplicates are expected**. Stage 2 removes them with `event_id` + `ON CONFLICT DO NOTHING`.
- No per-IP limit on failed auth. Roblox servers share IP ranges, so per-IP is a
  poor fit. The negative cache protects the database instead.
- gzip request bodies (Roblox `HttpService` can compress) would cut bandwidth. That's a Stage 3 decision.
