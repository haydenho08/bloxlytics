--!strict
-- Specs for the SDK. They swap HttpService:RequestAsync for a fake transport, so
-- they run in Studio without a network or an API. Run with tests/run.server.luau
-- (see the README).

local HttpService = game:GetService("HttpService")

return function(GamePulse: any)
	local specs: { { name: string, fn: () -> () } } = {}
	local function it(name: string, fn: () -> ())
		table.insert(specs, { name = name, fn = fn })
	end

	local function expectEqual(actual: any, expected: any, what: string)
		if actual ~= expected then
			error(`{what}: expected {tostring(expected)}, got {tostring(actual)}`, 2)
		end
	end

	local function waitUntil(condition: () -> boolean, timeout: number?)
		local deadline = os.clock() + (timeout or 3)
		while not condition() do
			if os.clock() > deadline then
				error("timed out waiting", 2)
			end
			task.wait()
		end
	end

	-- A fake API. `respond` decides each answer; every request is recorded with
	-- its body decoded.
	local function fakeApi(respond: ((n: number, body: any) -> any)?)
		local api = { requests = {} :: { any } }
		function api.transport(request: any)
			local body = HttpService:JSONDecode(request.Body)
			table.insert(api.requests, { url = request.Url, body = body, raw = request.Body, headers = request.Headers })
			local answer = respond and respond(#api.requests, body)
			if answer == "throw" then
				error("HttpError: ConnectFail")
			end
			return answer or { Success = true, StatusCode = 202, Body = "{}", Headers = {} }
		end
		function api.events(): { any }
			local out = {}
			for _, r in api.requests do
				for _, e in (r.body.events or {}) do
					table.insert(out, e)
				end
			end
			return out
		end
		return api
	end

	local function client(api: any, overrides: { [string]: any }?)
		local config: { [string]: any } = {
			gameId = "test-game",
			endpoint = "http://gamepulse.test/",
			apiKey = "gp_test",
			trackPlayers = false,
			bindToClose = false,
			flushInterval = 0.1,
			backoffBase = 0.05,
			backoffMax = 0.2,
			heartbeatInterval = 1000,
			transport = api.transport,
		}
		for k, v in overrides or {} do
			config[k] = v
		end
		return GamePulse.start(config)
	end

	local PLAYER = 123456789

	it("sends events in batches of maxBatchSize, in order", function()
		local api = fakeApi()
		local c = client(api, { flushInterval = 1000 })
		for i = 1, 120 do
			c:track("step", PLAYER, { i = i })
		end
		c:flush()
		waitUntil(function()
			return #api.events() >= 100
		end)
		c:shutdown(2)

		expectEqual(#api.requests, 3, "requests")
		expectEqual(#api.requests[1].body.events, 50, "first batch")
		expectEqual(#api.requests[2].body.events, 50, "second batch")
		expectEqual(#api.requests[3].body.events, 20, "last batch")
		for i, e in api.events() do
			expectEqual(e.properties.i, i, "order")
		end
		expectEqual(api.requests[1].url, "http://gamepulse.test/v1/events", "url (trailing slash trimmed)")
		expectEqual(api.requests[1].headers["X-API-Key"], "gp_test", "api key header")
	end)

	it("sends a full batch without waiting for the interval", function()
		local api = fakeApi()
		local c = client(api, { flushInterval = 1000, maxBatchSize = 5 })
		for _ = 1, 5 do
			c:track("step", PLAYER)
		end
		waitUntil(function()
			return #api.requests == 1
		end)
		c:shutdown(1)
	end)

	it("retries a 503 with the same events, then moves on", function()
		local api = fakeApi(function(n)
			if n <= 2 then
				return { Success = false, StatusCode = 503, Body = "busy", Headers = {} }
			end
			return nil
		end)
		local c = client(api)
		c:track("a", PLAYER)
		c:track("b", PLAYER)
		waitUntil(function()
			return c:getStats().sent == 2
		end)
		c:shutdown(1)

		expectEqual(#api.requests, 3, "requests")
		expectEqual(api.requests[1].raw, api.requests[3].raw, "retry sends the identical batch")
		expectEqual(c:getStats().retries, 2, "retries")
	end)

	it("retries network errors", function()
		local api = fakeApi(function(n)
			return if n == 1 then "throw" else nil
		end)
		local c = client(api)
		c:track("a", PLAYER)
		waitUntil(function()
			return c:getStats().sent == 1
		end)
		c:shutdown(1)
		expectEqual(#api.requests, 2, "requests")
	end)

	it("waits for Retry-After on a 429", function()
		local times = {}
		local api = fakeApi(function(n)
			table.insert(times, os.clock())
			if n == 1 then
				return { Success = false, StatusCode = 429, Body = "", Headers = { ["retry-after"] = "0.5" } }
			end
			return nil
		end)
		local c = client(api)
		c:track("a", PLAYER)
		waitUntil(function()
			return c:getStats().sent == 1
		end)
		c:shutdown(1)
		assert(times[2] - times[1] >= 0.45, `retried after {times[2] - times[1]}s, expected about 0.5s`)
	end)

	it("drops a batch the API refuses with 400 and carries on", function()
		local api = fakeApi(function(n)
			if n == 1 then
				return { Success = false, StatusCode = 400, Body = '{"error":"invalid_batch"}', Headers = {} }
			end
			return nil
		end)
		local c = client(api, { maxBatchSize = 1 })
		c:track("bad", PLAYER)
		c:track("good", PLAYER)
		waitUntil(function()
			return c:getStats().sent == 1
		end)
		c:shutdown(1)
		expectEqual(#api.requests, 2, "no retry of the 400")
		expectEqual(c:getStats().rejected, 1, "rejected")
		expectEqual(api.requests[2].body.events[1].name, "good", "next batch")
	end)

	it("drops the oldest events when the buffer is full", function()
		local api = fakeApi()
		local c = client(api, { flushInterval = 1000, maxBufferSize = 3 })
		for i = 1, 5 do
			c:track("step", PLAYER, { i = i })
		end
		c:shutdown(1)
		local events = api.events()
		expectEqual(#events, 3, "kept")
		expectEqual(events[1].properties.i, 3, "oldest kept")
		expectEqual(c:getStats().dropped, 2, "dropped")
	end)

	it("refuses events the API would reject, without sending them", function()
		local api = fakeApi()
		local c = client(api)
		c:track("has spaces", PLAYER)
		c:track("ok", -1) -- a Studio test player
		c:track("ok", PLAYER, { n = 0 / 0 })
		c:track("ok", PLAYER, { part = Instance.new("Part") })
		c:track("ok", PLAYER, { "an", "array" } :: any)
		c:track("ok", PLAYER, { blob = string.rep("x", 9000) })
		c:trackPurchase(PLAYER, 1, -5)
		c:shutdown(1)
		expectEqual(#api.requests, 0, "requests")
		expectEqual(c:getStats().rejected, 7, "rejected")
	end)

	it("encodes events the way the API expects", function()
		local api = fakeApi()
		local c = client(api)
		c:track("level_complete", PLAYER, { level = 3 })
		c:track("empty", PLAYER)
		c:shutdown(1)
		local raw = api.requests[1].raw
		local events = api.events()
		expectEqual(events[1].type, "custom", "type")
		expectEqual(events[1].game_id, "test-game", "game_id")
		expectEqual(events[1].player_id, PLAYER, "player_id")
		assert(string.match(events[1].event_id, "^%x+%-%x+%-%x+%-%x+%-%x+$"), "event_id is a GUID")
		-- An empty table would encode as [], which the API rejects; it must be left out.
		expectEqual(events[2].properties, nil, "empty properties omitted")
		-- Epoch milliseconds must be written out in full, not as 1.79e+12.
		assert(not string.find(raw, "e%+"), `numbers in exponent form: {raw}`)
		local ts = events[1].timestamp
		assert(math.abs(ts - DateTime.now().UnixTimestampMillis) < 60000, "timestamp is epoch ms")
	end)

	it("gives a receipt the same event id every time it's tracked", function()
		local api = fakeApi()
		local c = client(api)
		local receipt = { PlayerId = PLAYER, ProductId = 42, CurrencySpent = 99, PurchaseId = "abc123" }
		c:trackReceipt(receipt)
		c:trackReceipt(receipt) -- ProcessReceipt called again for the same purchase
		c:trackReceipt({ PlayerId = PLAYER, ProductId = 42, CurrencySpent = 99, PurchaseId = "def456" })
		c:shutdown(1)
		local events = api.events()
		expectEqual(events[1].event_id, events[2].event_id, "same purchase, same id")
		assert(events[1].event_id ~= events[3].event_id, "different purchase, different id")
		expectEqual(events[1].properties.robux, 99, "robux")
		expectEqual(events[1].properties.product_id, 42, "product_id")
		expectEqual(events[1].properties.purchase_id, "abc123", "purchase_id")
	end)

	it("sends a heartbeat when it has had nothing to send for a while", function()
		local api = fakeApi()
		local c = client(api, { heartbeatInterval = 0.2 })
		waitUntil(function()
			return c:getStats().heartbeats >= 1
		end)
		c:shutdown(1)
		expectEqual(api.requests[1].url, "http://gamepulse.test/v1/heartbeat", "url")
		expectEqual(api.requests[1].body.game_id, "test-game", "game_id")
		expectEqual(api.requests[1].body.players, #game:GetService("Players"):GetPlayers(), "players")
	end)

	it("stays within its request budget", function()
		local api = fakeApi()
		local c = client(api, { maxBatchSize = 1, maxRequestsPerMinute = 3 })
		for _ = 1, 10 do
			c:track("step", PLAYER)
		end
		task.wait(0.5)
		expectEqual(#api.requests, 3, "requests in the first half second")
		c:shutdown(1) -- shutdown ignores the budget and drains the rest
		expectEqual(c:getStats().sent, 10, "sent")
	end)

	it("drains everything on shutdown in batches of up to 100", function()
		local api = fakeApi()
		local c = client(api, { flushInterval = 1000 })
		for _ = 1, 150 do
			c:track("step", PLAYER)
		end
		c:shutdown(2)
		expectEqual(#api.requests, 2, "requests")
		expectEqual(#api.requests[1].body.events, 100, "first")
		expectEqual(c:getStats().sent, 150, "sent")
		expectEqual(c:getStats().queued, 0, "queued")
	end)

	return specs
end
