# loadgen

Simulates N Roblox game servers x M players sending events to the ingestion API,
behaving like the Luau SDK (buffer, batch of 50 or every 10s, one request in
flight per server, gzip bodies, retry the same batch on 429/503). It steps
through target rates and reports, per step:

- accepted events/sec and requests/sec
- ingest latency (POST to `202`) p50 / p95 / p99
- 429 / 503 / error counts
- the stream backlog at the end of the step (are the workers keeping up?)
- store lag: `stored_at - received_at` from Postgres, p50 / p95
- whether the rate was **sustained** (all accepted, nothing piling up anywhere)

```powershell
# From the repo root. Uses DATABASE_URL / REDIS_URL from .env to issue a key for
# game "loadtest" and to measure the backlog and store lag.
npm.cmd run loadgen -- --servers 100 --players 20 --steps 1000,2000,4000 --step-seconds 30
```

| Option           | Default                 |                                                     |
| ---------------- | ----------------------- | --------------------------------------------------- |
| `--url`          | `http://127.0.0.1:8080` | Ingestion API                                       |
| `--game`         | `loadtest`              | Created if missing                                  |
| `--key`          | issued for the run      | Use an existing key instead (e.g. against a deploy) |
| `--servers`      | 50                      | Simulated game servers                              |
| `--players`      | 20                      | Players per server                                  |
| `--steps`        | `500,1000,2000`         | Target total events/sec, one step each              |
| `--step-seconds` | 30                      | Measured time per step                              |
| `--warmup`       | 5                       | Unmeasured seconds at the start of each step        |
| `--batch`        | 50                      | Events per request (the SDK's batch size)           |
| `--flush-ms`     | 10000                   | Send a partial batch after this long                |
| `--no-gzip`      |                         | Send plain JSON                                     |

The per-game rate limit (500 events/s by default) applies, so for a benchmark
start the API with `RATE_LIMIT_EVENTS_PER_SEC` and `RATE_LIMIT_BURST` raised.
See [docs/stage-5.md](../../docs/stage-5.md).
