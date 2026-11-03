# sdk-luau

Server-side Roblox SDK for GamePulse. A ModuleScript that buffers gameplay events
and sends them to the ingestion API in batches. See [docs/stage-3.md](../../docs/stage-3.md)
for how it works and why.

```
src/GamePulse/        the SDK (init.luau + EventQueue, RequestBudget, Validate, Guid)
tests/                specs that run in Studio against a fake HTTP transport
example/              a tiny place: auto join/leave, a Checkpoint custom event, ProcessReceipt
*.project.json        Rojo projects: default (the module), example (a place), test (the specs)
```

## Use it in a game

1. Put `GamePulse` in **ServerScriptService** (never in ReplicatedStorage or a
   LocalScript: the key would ship to every player's device).
2. **Game Settings > Security > Allow HTTP Requests**: on.
3. Store the key from `npm run create-game` as an **experience secret** named
   `gamepulse_api_key` (Creator Dashboard > your experience > Secrets), restricted
   to your API's domain.
4. In a server Script:

```lua
local GamePulse = require(game:GetService("ServerScriptService").GamePulse)
local analytics = GamePulse.start({
	gameId = "my-obby",
	endpoint = "https://ingest.example.com",
})

analytics:track("level_complete", player, { level = 3 })

MarketplaceService.ProcessReceipt = function(receiptInfo)
	-- grant the item, then:
	analytics:trackReceipt(receiptInfo)
	return Enum.ProductPurchaseDecision.PurchaseGranted
end
```

Joins and leaves are tracked automatically, and everything buffered is flushed
on `BindToClose`.

| Option                 | Default             | Meaning                                              |
| ---------------------- | ------------------- | ---------------------------------------------------- |
| `flushInterval`        | 10                  | seconds between sends                                |
| `maxBatchSize`         | 50                  | send early once this many are waiting (max 100)      |
| `maxBufferSize`        | 5000                | buffer cap; the oldest events are dropped beyond it  |
| `heartbeatInterval`    | 60                  | send a heartbeat after this long with no request     |
| `maxRequestsPerMinute` | 60                  | this SDK's share of HttpService's ~500/min           |
| `apiKeySecret`         | `gamepulse_api_key` | experience secret holding the key                    |
| `apiKey`               | none                | the key itself, **Studio testing only**              |
| `compress`             | true                | gzip request bodies                                  |
| `debug`                | false               | print each send                                      |

`analytics:getStats()` returns `{ queued, dropped, sent, rejected, retries, heartbeats }`.

## Test in Studio

Studio's HttpService can reach `localhost`, so no tunnel is needed for Studio
testing. Install Rojo once (`rokit install` reads `rokit.toml`; get Rokit from
github.com/rojo-rbx/rokit), then:

```powershell
npm.cmd run infra:up; npm.cmd run dev:api     # terminal 1
npm.cmd run dev:worker                        # terminal 2
cd packages/sdk-luau; rojo serve example.project.json   # terminal 3, then Connect in Studio's Rojo plugin
```

On the `Analytics` script, set the attributes `GameId`, `Endpoint`
(`http://localhost:8080`) and `ApiKey` (Studio only: clear it before publishing).
Press Play, touch the green part, stop. The events are in Postgres.

Specs: `rojo serve test.project.json`, connect, press Play. Output prints
`[GamePulse specs] 13 passed, 0 failed`.

A **published** game runs on Roblox's servers, which can't reach your laptop. For
that, give the API a public HTTPS URL: deploy it (Stage 5) or run a tunnel such as
`cloudflared tunnel --url http://localhost:8080` and use the URL it prints as `endpoint`.
