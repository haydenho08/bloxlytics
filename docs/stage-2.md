# Stage 2: Worker + storage

**Goal:** take events off the Redis Stream, store each one in Postgres
**exactly once** even though Redis delivers them **at least once**, and keep the
rollup tables the dashboard will read (players online, DAU, retention, revenue).

## The worker's loop

```
loop:
  1. retrying a batch?  renew its claim (XCLAIM JUSTID), try it again
  2. reclaim due?       XAUTOCLAIM entries idle > 60s (their worker died)
  3. otherwise          XREADGROUP ... COUNT 500 BLOCK 2000 STREAMS bx:events >
  4. decode each entry  bad JSON / bad shape          -> dead letter ("invalid")
                        delivered > 5 times           -> dead letter ("too_many_deliveries")
  5. store the batch    ONE transaction: raw insert + write-time rollups, COMMIT
                        data error? store one by one, bad one -> dead letter ("rejected")
                        outage?     throw, back off, go to 1 (nothing acknowledged)
  6. MULTI: XADD dead letters + XACK everything handled
  7. trim entries every group has acknowledged (Lua: XINFO + XPENDING + XTRIM MINID)

every 15s (one worker at a time): recompute players-online and retention windows
```

Code: [`worker.ts`](../packages/worker/src/worker.ts) (the loop),
[`store.ts`](../packages/worker/src/store.ts) (the transaction),
[`rollups.ts`](../packages/worker/src/rollups.ts) (the periodic job),
migrations [`002`](../packages/db/migrations/002_events.sql) and
[`003`](../packages/db/migrations/003_rollups.sql).

## Design decisions (and the interview questions they answer)

### At-least-once delivery + idempotent processing = effectively exactly-once
> "Is your pipeline exactly-once?" / "What happens if a worker crashes?"

Honest answer: **delivery** is at-least-once; **storage** is exactly-once.

- An entry stays in the consumer's *pending entries list* (PEL) until `XACK`.
  We ack only **after** `COMMIT`. A crash anywhere before the commit leaves the
  entry pending, so it gets redelivered. Nothing is lost.
- A crash *between* `COMMIT` and `XACK` redelivers an event that's already
  stored. True exactly-once delivery would need Redis and Postgres to commit
  together (two-phase commit). We don't have that, and it's slow and fragile anyway.
- So the processing is made **idempotent** instead. `event_id` is the primary key,
  the insert is `ON CONFLICT (event_id) DO NOTHING`, and a second delivery is a no-op.
  The same mechanism absorbs SDK retries (Stage 1 noted that duplicates are expected).

The other order (ack first, then write) is **at-most-once**: a crash after the ack
loses the event. For analytics, a duplicate we can detect beats a gap we can't.

Tests: "counts the same event only once when it is sent twice" and "does not
double count when a worker crashes after committing but before acknowledging".

### Rollups must be idempotent too, not just the raw insert
This is the subtle part, and a good thing to bring up yourself in an interview.
If the raw insert skips a duplicate but the rollup code still runs
`revenue = revenue + 99`, revenue is double counted even though `events` looks fine.

The fix: the insert `RETURNING event_id` gives exactly the rows that were **new**,
and every write-time rollup is computed only from those rows, **in the same
transaction**. Either the event and its rollup contributions all commit, or none do.
A redelivery inserts nothing, so it contributes nothing.

DAU needs one more step because it's a count of *distinct* players. `player_days
(game_id, player_id, day)` is the "already counted?" memory: insert with
`DO NOTHING RETURNING`, and only rows it newly accepts add to `daily_active_users`.

### Write-time vs read-time rollups: we use both, deliberately
> "When do you pre-aggregate vs compute on query?"

| Rollup                 | When                                  | Why                                                                     |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| revenue per day        | write time, `+=` in the insert tx     | one event changes one row by a known amount                             |
| DAU                    | write time, via `player_days`         | same, once "distinct" is handled                                        |
| players online/minute  | periodic recompute of the last 60 min | one join affects *every* minute until the leave; easier to recompute    |
| day-1/day-7 retention  | periodic recompute of last 15 cohorts | a late event can move a player to an earlier cohort                     |

Write time: always fresh, reads are trivial, but it adds work (and row locks) to
every insert, and it's hard to change the definition later. Periodic recompute:
simpler to get right, and idempotent by **overwriting** (delete the window,
reinsert). Running it twice gives the same rows. The cost is up to 15s of staleness
and repeated work. Pure read time (computing from raw events on every dashboard
load) is the third option. The project rules it out because it gets slower as the
events table grows.

Why only a window? Events are accepted up to 7 days late, so a cohort can
change until 14 days after its first day: hence 15 days. For players online we
pick 60 minutes. A session event more than an hour late won't revise old
minutes. That's an accepted trade for a *live* metric.

Only one worker runs the job at a time: `pg_try_advisory_xact_lock`. The others
skip their turn rather than queue. The lock is released automatically at commit,
even if the worker dies.

### Players online: sessions, and servers that crash
`player_sessions` pairs each `player_join` with the next `player_leave` on that
server. A minute's count is distinct players whose session overlaps it.

> "What if a game server crashes and never sends player_leave?"

Every event updates `game_servers.last_seen_at` (our clock). An open session on a
server quiet for more than 5 minutes is treated as ended when the server was last
heard from. **Stage 3 consequence:** the SDK must send something at least every
few minutes even when nothing happens, or quiet-but-alive servers look dead.

### Retention definition
Cohort = players first seen on day D (UTC). Day-1 retention = share of that cohort
active on D+1. Day-7 = active on exactly D+7 (classic "Day N", not "within 7 days").
The number stays `NULL` until that day is over, so a young cohort doesn't show 0%.
`players.first_seen_at` takes `LEAST(...)`, so a late event can move a player to
an earlier cohort. That's why retention is recomputed, not incremented.

### Retries and the dead letter stream
> "How do you handle poison messages?"

Different failures need different handling:

- **Malformed entry** (bad JSON, fails the schema): it will never get better.
  Dead-letter it straight away. The worker re-validates with the shared schema
  *minus the clock checks*: an entry read after a long backlog mustn't become
  "too old" after the API accepted it.
- **Data error from Postgres** (SQLSTATE class 22 or 23, e.g. a deleted game's
  foreign key): one bad event fails the whole transaction. The worker then stores
  the batch **one event at a time**, so the good ones go through and only the bad
  one is dead-lettered. Test: "isolates an event the database rejects".
- **Everything else is treated as transient** (connection refused, timeout,
  deadlock, even "column does not exist" from a forgotten migration). Keep the
  batch in memory and retry it with **exponential backoff and full jitter** (random
  0..min(30s, 200ms·2ⁿ)), so a fleet of workers doesn't retry in lockstep.
  Throwing data away because the database was down would turn an outage into data
  loss. When in doubt, keep the data.
- **A message that kills the worker** (crash loop): the worker can't catch it, so
  it's caught by the delivery count. Each `XAUTOCLAIM` bumps it, and above 5 the
  entry is dead-lettered without being processed.

The subtle part: during a long Postgres outage, another worker would see our batch
idle for 60s and claim it, bumping its delivery count. Do that a few times and
good events end up dead-lettered. So while retrying, the worker **renews its lease**
with `XCLAIM ... JUSTID`, which resets the idle time *without* bumping the count.
Test: "does not acknowledge anything until Postgres has committed" checks the count stays 1.

Dead-lettering and acking happen in **one `MULTI`**, so an entry is never acked
without its copy in `bx:events:dlq` (with `reason`, `error`, `source_id`). Inspect it
with `XRANGE bx:events:dlq - +`. Replaying it is a deliberate human step.

### Trimming the stream (the carry-over from Stage 1)
`XACK` doesn't delete entries. The API's backpressure check counts `XLEN`, so
without trimming it would eventually return 503 with an empty backlog. After each
batch, a Lua script finds, for **every** consumer group, the oldest entry not yet
done (oldest pending, or just after the last delivered), and runs
`XTRIM MINID` to the smallest of those. Checking all groups matters: a future
second group (say, a live dashboard feed) mustn't lose entries it hasn't read.
Tests: the stream is back to `XLEN 0` after processing; entries pending in a
crashed consumer or unread by another group are kept.

### Batching and the SQL
- One read = up to 500 entries = **one transaction**. Commit cost (an fsync) is
  paid once per batch, not per event. That's the main throughput lever.
- The whole batch is one JSON parameter unpacked by `jsonb_to_recordset`: one
  round trip whatever the batch size.
- **Deadlocks:** two workers upserting the same rollup rows (`daily_active_users`
  for today) in different orders could each hold one lock and wait for the other.
  Every multi-row upsert is `ORDER BY` its key, so they always lock in the same
  order. If a deadlock happens anyway (40P01), it's classified as transient and retried.
- **Hot rows:** every batch for a game updates the same DAU/revenue row for
  today, so those writes serialise across workers. Fine at our scale. At high
  scale you'd shard the counter or pre-aggregate per batch in memory. Stage 5's
  load test will show whether it matters.

### The raw events table and its index
> "How did you choose your indexes?"

Primary key `event_id` (that *is* the idempotency) plus one index,
`(game_id, occurred_at)`. Every query on raw events is "this game, this time
range": rollup recomputes, the dashboard's recent-events feed (a backwards scan
of the same index), debugging. `game_id` goes first because queries always fix it
to one value (equality); `occurred_at` second so the range is one contiguous slice
of the index. No index on `player_id` or `type`: nothing reads raw events that way,
and every index makes every insert slower.

Three timestamps per event: `occurred_at` (game's clock), `received_at` (API's),
`stored_at` (DB's). `stored_at - received_at` is the pipeline lag, which is 48ms in
the manual run below.

At real scale you'd **partition** `events` by month: old months drop instantly
and indexes stay small. Not needed yet.

### Graceful shutdown and scaling out
SIGINT/SIGTERM: stop reading, **finish and ack the batch in hand**, finish the
rollup job, then close Redis and Postgres. On a clean exit with nothing pending,
the worker removes its consumer name from the group (`XGROUP DELCONSUMER`). If it's
killed instead, nothing is lost: its pending entries are reclaimed by others after 60s.

To scale, run more workers with unique consumer names (default `hostname-pid`).
The consumer group hands each entry to exactly one of them. Ordering across
workers isn't guaranteed. That's fine, because nothing depends on processing order:
sessions are paired by timestamp, and first-seen uses `LEAST`.

## Tests

`npm test`: 50 tests (21 new), real Postgres + Redis.

| Behaviour                                      | Test                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Stored, acked, stream trimmed to 0             | stores every event, acknowledges it, and trims the stream        |
| **Same event twice -> counted once**           | counts the same event only once when it is sent twice            |
| Crash between commit and ack                   | does not double count when a worker crashes after committing...  |
| Ack only after commit; outage doesn't DLQ      | does not acknowledge anything until Postgres has committed       |
| Poison entries                                 | malformed -> DLQ; FK violation isolated; too many deliveries     |
| Trim safety                                    | keeps entries pending, or unread by another group                |
| DAU / revenue / sessions                       | distinct per UTC day; sums; join/leave pairing across batches    |
| Players online                                 | join->leave span; crashed server; window replaced on rerun       |
| Retention                                      | d1/d7 per cohort, NULL until known; late event moves cohort      |
| Refresh lock / graceful stop                   | skips when locked; stop() finishes and leaves the group          |

## Manual check (what I ran)

API + worker on the dev stack. The worker first drained the ~2,500 events left
on the stream from the Stage 1 manual test (500 per batch, ~370ms each, so
roughly 1,300 events/s for one worker; Stage 5 measures it properly). Then real
HTTP: a 4-event batch, **the same batch again** (an SDK retry), and a
`player_leave`. Result: 5 rows in `events`, revenue 99 (not 198), DAU 2, one
session closed and one open, players online 2, `XLEN bx:events` 0, nothing pending.

## Things to be ready to discuss
- Why not Kafka's exactly-once (transactions)? It only covers Kafka-to-Kafka. Writing
  to an external database still needs idempotency, which is what we did.
- `event_id` is globally unique, not per game. A malicious game that knew another
  game's GUIDs could pre-insert them. GUIDs are random, so this is theoretical. The
  fix is a `(game_id, event_id)` key.
- A `player_leave` whose join never arrived is ignored. A player already in the
  server when the SDK starts has no join. Stage 3's SDK should send joins for
  players already present when it starts.
