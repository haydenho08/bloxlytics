# Stage 3: Luau SDK

**Goal:** a ModuleScript a Roblox developer drops into their game that sends
events to Bloxlytics reliably. It must never hurt the game: no lag, no unbounded
memory, no using up the game's HTTP budget, no crash if our API is down.

## How a tracked event travels

```
analytics:track("level_complete", player, {level = 3})
  1. validate      same rules as the API; a bad event is refused HERE, alone
  2. buffer        EventQueue (cap 5000; full -> drop the OLDEST)
  3. sender thread wakes every 0.25s. Sends when:
                   50 events waiting  OR  10s since the last send  OR  flush()  OR  shutdown
  4. budget        a token bucket: at most 60 requests/min (Roblox allows ~500/min per server, shared)
  5. POST /v1/events  gzip, X-API-Key from an experience secret
       202            done
       429/5xx/408/network error   keep the SAME batch, wait (Retry-After or backoff), resend
       other 4xx      drop the batch, warn (retrying can't fix it)
  idle 60s -> POST /v1/heartbeat
  BindToClose -> leave events for players still here, drain in batches of 100, 25s max
```

Code: [`src/Bloxlytics/init.luau`](../packages/sdk-luau/src/Bloxlytics/init.luau).
The server side gained [`/v1/heartbeat`](../packages/api/src/routes/events.ts) and
[gzip bodies](../packages/api/src/compression.ts).

## Design decisions (and the interview questions they answer)

### Why server-side only?
> "Why not track from the client?"

A LocalScript runs on the player's device, so the API key would ship to every
player, and exploiters can run any code they like on their own client: they
could send fake purchases or flood us. Server scripts in ServerScriptService are
never sent to clients. The rule: **never trust the client**. The server sees
joins, leaves and purchases first-hand anyway.

### Batching, and why one sender thread
One HTTP request per event would spend the HttpService budget in seconds and
add overhead to every event. Batching amortises it: 50 events per request.
"Every 10 seconds or 50 events, whichever comes first" bounds both latency (an
event waits at most ~10s) and request size.

There's exactly **one thread that sends**, one request at a time. Two parallel
requests could arrive out of order, and the worker pairs `player_join` with the
next `player_leave`. One sender also makes the retry logic simple.

### Retry, backoff, and which errors to retry
> "How does your client handle failures?"

- **Retry** network errors, `429`, `408` and `5xx`. They mean "not now", not "never".
- **Don't retry other `4xx`.** `400` means the batch is invalid, and resending gives
  the same `400` forever, blocking every event queued behind it (head-of-line
  blocking). Drop it and warn.
- The failed batch stays as `_pending` and is resent **identically**, so the API
  sees the same `event_id`s and the worker's `ON CONFLICT` removes any duplicate.
  The retry is safe *because* Stage 2 made processing idempotent.
- **Exponential backoff with full jitter:** wait `random(0, min(60, 1·2^attempt))`
  seconds. Imagine our API restarts: thousands of game servers fail at the same
  moment. Without jitter they'd all retry at the same moment too, and knock it
  over again (a *thundering herd*). Random waits spread them out.
- **`Retry-After`** from a `429`/`503` overrides the backoff: the server knows best.

### The buffer: bounded, drop oldest
> "What happens if your API is down for an hour?"

Events keep buffering, up to `maxBufferSize` (5000). After that, each new event
**drops the oldest**. A game server's memory is shared with the game itself,
so analytics must never grow without limit. Newest-first is the better loss: the
recent data matters most, and old events would hit the API's 7-day age limit anyway.
Dropped events are counted (`getStats().dropped`) and warned about, at most once a minute.

The queue uses head/tail indices instead of `table.remove(t, 1)`, which shifts
every element (O(n) per removal).

### Respecting HttpService's limits
Roblox allows each game server about **500 HTTP requests per minute**, shared by
*every* script in the game. If analytics used them all, the game's own requests
(webhooks, matchmaking) would start failing. So the SDK holds itself to 60/minute
with a **token bucket**, the same algorithm as the API's rate limiter, running on the client.
At normal load it uses 6/minute (one batch every 10s). At shutdown it ignores the
budget: there's no "later" to save it for.

### Validating in the SDK too
The API rejects a whole batch if one event is invalid, and the SDK doesn't retry
`400`s, so one bad event would cost the 49 good ones in its batch. Validating
before buffering costs only that event, and the warning points at the line of
game code that made it. Things it catches:
- event names outside `[A-Za-z0-9_.:-]`
- properties that aren't a dictionary, are over 8 KiB, contain `NaN`/infinity, or
  contain an `Instance` (JSON can't represent them)
- **Studio test players:** "local server" test players have *negative* UserIds,
  which the API refuses.

**A Roblox quirk worth knowing:** `HttpService:JSONEncode({})` gives `[]`, because
Luau has one table type for both arrays and dictionaries, and an empty one looks
like an empty array. The API wants `properties` to be an object, so the SDK leaves
empty properties out entirely (the API defaults them to `{}`). Verified in Studio.

### Idempotent purchases
> "How do you avoid double-counting revenue?"

Roblox calls `ProcessReceipt` again for the same purchase until the game returns
`PurchaseGranted`, and again after a crash. `trackReceipt` builds the `event_id`
**deterministically** from the receipt's `PurchaseId` (a hash formatted as a GUID),
so a purchase tracked twice has one id, and Stage 2's `ON CONFLICT DO NOTHING`
keeps one copy. Same idea as an *idempotency key* in payment APIs like Stripe's.

The hash is FNV-1a run four times for 128 bits. It's not cryptographic, and doesn't need
to be: we need equal inputs to give equal ids, not secrecy. One detail:
multiplying by the FNV prime can exceed 2^53, where Luau's doubles stop being exact
integers, so the multiply is split into a shift plus a small product.

### Heartbeats (the Stage 2 carry-over)
The worker ends sessions on a server that has gone quiet for 5 minutes (it
probably crashed), so a quiet-but-alive server must say so. After 60s with no
request, the SDK sends `POST /v1/heartbeat {game_id, server_id, players}`.
It goes through **the same stream** as events, so the API still never touches
Postgres, and heartbeats are processed in order with the events around them.
Verified live: `game_servers.last_seen_at` moved forward 60s after the last event.

The SDK also sends `player_join` for players already in the server when it starts
(the other carry-over), so their sessions aren't missing.

### Graceful shutdown: BindToClose
Roblox gives `BindToClose` callbacks up to 30 seconds. The SDK:
1. sends `player_leave` for everyone still present (with a set so `PlayerRemoving`
   can't add a second one)
2. cuts any long backoff down to 1 second
3. drains the buffer in batches of 100 (the API's maximum) to use as few requests
   as possible
4. gives up at 25 seconds, leaving a margin, and warns how many events were lost.
Verified live: stopping Play delivered the leave and closed the session.

### Keeping the API key out of the place file
The key is stored as an **experience secret**, and `HttpService:GetSecret` returns a
`Secret` object. It can go straight into a request header, but its value can't be read or
printed from Luau. Anyone with edit access to the place (Team Create
collaborators, an uncopylocked copy, a leaked free model) would see a key pasted in
code. They don't see a secret. Secrets are also restricted to the domains you allow.
`apiKey` in config exists for Studio testing only, and warns outside Studio.

### gzip
`Compress = Enum.HttpCompression.Gzip` makes Roblox gzip the body and send
`Content-Encoding: gzip` (verified with an echo server). JSON events repeat the
same keys over and over, so they compress very well. In tests, 50 events took about
1.3 KB on the wire. The API decompresses in a `preParsing` hook, and its 1 MiB limit
applies to the **decompressed** size. That defends against a *zip bomb* (5 KB of gzip
that expands to 20 MB), which the API turns into a `413`. There's a test for it.

### Testable without a network
The transport (`HttpService:RequestAsync`) and the clock can be swapped via config,
so the specs use a **fake API**. It can be told to return a `503`, throw a network error,
or return a `429` with `Retry-After`. All 13 specs run in a real Roblox server in about
3.5s. This is dependency injection again, as with `buildApp()` in Stage 1.

## What I verified in Studio (not just assumed)
| Question                                          | Answer                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Does `JSONEncode` write ms timestamps in full?    | Yes: `1793671009716`, and 2^53 in full. No `1.79e+12`.                        |
| Does `JSONEncode({})` give `{}`?                  | No, `[]`. That's why empty properties are left out.                           |
| Does `Compress = Gzip` set `Content-Encoding`?    | Yes, and 2,512 bytes went over the wire as 99.                                |
| Can Studio's HttpService reach `localhost`?       | Yes (edit mode and a Play server). No tunnel needed to test in Studio.       |
| End to end                                        | Play, join, touch Checkpoint, idle 70s, stop: join, custom, heartbeat and leave all in Postgres; session closed; players-online 1 |

A **published** game runs on Roblox's servers, which can't reach `localhost`.
Then you need a public URL: a tunnel for a quick test, or a deployment (Stage 5).
See the [SDK README](../packages/sdk-luau/README.md).

## Things to be ready to discuss
- **Events lost on a hard crash.** If the server process dies (not a normal
  shutdown), the in-memory buffer is gone: up to ~10s of events. Persisting it
  (DataStore, MemoryStore) would cost requests and latency on every event. For
  analytics, that's the right trade. For purchases, the receipt system is the
  real record anyway.
- **Clock skew.** Event time comes from the game server's clock. The API refuses
  anything more than 5 minutes in the future, and `received_at` records our clock.
- **The `Roblox-Id` header.** Roblox adds the place id to every request. It
  could check that a key is used from the right place, but anyone outside Roblox
  can fake headers, so it'd be a sanity check, not security.
- **Why not Roblox's built-in AnalyticsService?** It exists and is good. Building
  this is about the backend: we own the data, define our own metrics, and the
  pipeline is the project.
