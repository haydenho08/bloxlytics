# worker

Reads events from the Redis Stream as part of a consumer group, stores them in
Postgres exactly once, and maintains the rollup tables. See [docs/stage-2.md](../../docs/stage-2.md).

```powershell
npm.cmd run dev:worker   # from the repo root
```

Run more than one to scale out: each needs a unique `WORKER_CONSUMER` (the default,
`<hostname>-<pid>`, already is).
