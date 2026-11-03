# Deploying Bloxlytics

Everything runs from one Docker image ([Dockerfile](../Dockerfile)). A deployment needs:

| Piece            | Start command                                          | Public? |
| ---------------- | ------------------------------------------------------ | ------- |
| migrations       | `node --import tsx packages/db/scripts/migrate.ts`      | runs once per deploy |
| ingestion API    | `node --import tsx packages/api/src/main.ts`            | yes: game servers POST here |
| worker(s)        | `node --import tsx packages/worker/src/main.ts`         | no |
| dashboard        | `node --import tsx packages/dashboard-api/src/main.ts`  | yes: serves the app and its API |
| PostgreSQL 16    | managed                                                 | no |
| Redis 7          | managed, **with persistence** (the stream is the queue) | no |

The image already sets `API_HOST`/`DASHBOARD_API_HOST=0.0.0.0` and
`DASHBOARD_STATIC_DIR`. Both HTTP services listen on `$PORT` if the platform sets
it. Each service needs `DATABASE_URL` and `REDIS_URL`.

Roblox game servers can only reach **public HTTPS** URLs, which is the real reason
to deploy: `localhost` only works in Studio.

## Option A: Railway (recommended, about $5–10/month)

Railway runs Docker images from a GitHub repo and offers Postgres and Redis next
to them, with private networking between them. The Hobby plan is $5/month,
including $5 of usage. A small idle setup like this should be close to that. Check
their current pricing, and the button names below may have changed.

1. Push the repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it. This first
   service becomes the **api**.
3. **+ New → Database → PostgreSQL**, and **+ New → Database → Redis**.
4. Add two more services from the same repo: **worker** and **dashboard**.
5. For each of the three services, under Settings:
   - Builder: Dockerfile (auto-detected).
   - Custom start command: from the table above.
   - **api** only: pre-deploy command `node --import tsx packages/db/scripts/migrate.ts`.
6. Variables, on each service:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   ```
   On **dashboard**, also add `DASHBOARD_PASSWORD=<something long>`. It's served
   publicly, and your revenue numbers are on it.
7. Settings → Networking → **Generate Domain** for **api** and **dashboard**.
8. Create a game. Use the Railway CLI from your machine, or a one-off command in
   the api service:
   ```bash
   railway run --service api node --import tsx packages/db/scripts/create-game.ts my-obby "My Obby"
   ```
9. In Roblox: in Creator Hub → your experience → **Secrets**, add
   `bloxlytics_api_key` with the key, restricted to the api's domain. In the
   place, set the SDK's `endpoint` to `https://<api domain>`. Turn on
   **Allow HTTP Requests** in Game Settings.

To scale out, raise the worker service's replica count. Each replica gets its own
hostname, so `WORKER_CONSUMER` stays unique automatically.

To benchmark the deployment from your machine with an existing key:
```bash
npm run loadgen -- --url https://<api domain> --key bx_... --steps 200,500 --step-seconds 20
```
(Without `DATABASE_URL`/`REDIS_URL` pointing at production, it reports latency
and throughput but not backlog or store lag.)

## Option B: one free VM (Oracle Cloud Always Free, $0)

Oracle's Always Free tier includes an Arm VM with up to 4 cores and 24 GB of RAM,
easily enough to run the whole `docker compose` stack. You get no managed
backups, and you're the sysadmin.

```bash
# On the VM (Ubuntu), after installing Docker:
git clone https://github.com/haydenho08/bloxlytics.git && cd bloxlytics
DASHBOARD_PASSWORD='something-long' docker compose --profile app up -d --build
```

Put [Caddy](https://caddyserver.com/) in front for HTTPS (it gets certificates
automatically). Point two DNS names at the VM, then use a two-line Caddyfile:

```
ingest.example.com    { reverse_proxy localhost:8080 }
dashboard.example.com { reverse_proxy localhost:8082 }
```

Change the Postgres password in `docker-compose.yml` before exposing anything, and
open only ports 80/443 in the VM's firewall. Postgres and Redis must not be public.

## Why not…

- **Render's free tier:** web services sleep when idle and background workers
  aren't free, and the worker has to run all the time.
- **Serverless Redis (e.g. Upstash free):** billed per command, and the worker's
  blocking `XREADGROUP` loop alone sends tens of thousands of commands a day.
- **Vercel/Netlify:** fine for the static dashboard alone, but the API and the
  worker are long-running processes.
