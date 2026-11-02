--!strict
-- GamePulse: server-side analytics SDK for Roblox.
--
--   local GamePulse = require(ServerScriptService.GamePulse)
--   local analytics = GamePulse.start({ gameId = "my-obby", endpoint = "https://ingest.example.com" })
--   analytics:track("level_complete", player, { level = 3 })
--
-- Events are buffered and sent in batches from one background thread: every
-- `flushInterval` seconds, or as soon as `maxBatchSize` events are waiting. A
-- batch that fails with a network error, 429 or 5xx is retried, in order, with
-- exponential backoff. One that fails with any other 4xx is dropped (retrying
-- can't fix bad data, and it would block everything queued behind it).
--
-- Server only. A LocalScript would have to ship the API key to every player's
-- device, and exploiters could send whatever events they liked.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local EventQueue = require(script.EventQueue)
local Guid = require(script.Guid)
local RequestBudget = require(script.RequestBudget)
local Validate = require(script.Validate)

local GamePulse = {}
GamePulse.__index = GamePulse
GamePulse.VERSION = "0.1.0"

-- The API's batch limit. Normal flushes use maxBatchSize; shutdown uses this to
-- drain the buffer in as few requests as possible.
local API_MAX_BATCH = 100

export type Config = {
	--- The game's id in GamePulse, e.g. "my-obby" (from `npm run create-game`).
	gameId: string,
	--- Base URL of the ingestion API, e.g. "https://ingest.example.com".
	endpoint: string,
	--- Name of the experience secret holding the API key (Game Settings > Security).
	apiKeySecret: string?,
	--- The key itself. For Studio testing only; never publish a place with it.
	apiKey: string?,
	flushInterval: number?,
	maxBatchSize: number?,
	maxBufferSize: number?,
	--- Send a heartbeat after this many seconds with no other request.
	heartbeatInterval: number?,
	--- This SDK's share of HttpService's ~500 requests/minute per server.
	maxRequestsPerMinute: number?,
	--- Send player_join / player_leave automatically.
	trackPlayers: boolean?,
	--- Flush on game:BindToClose.
	bindToClose: boolean?,
	--- How long the shutdown flush may take (Roblox allows 30 s in total).
	shutdownTimeout: number?,
	--- gzip request bodies.
	compress: boolean?,
	backoffBase: number?,
	backoffMax: number?,
	debug: boolean?,
	--- For tests: replaces HttpService:RequestAsync.
	transport: ((request: { [string]: any }) -> { [string]: any })?,
	--- For tests: replaces os.clock.
	clock: (() -> number)?,
}

export type Stats = {
	queued: number,
	--- Events dropped because the buffer was full.
	dropped: number,
	--- Events the API accepted.
	sent: number,
	--- Events the API refused (non-retryable 4xx) or that failed validation.
	rejected: number,
	--- Failed requests that will be (or were) retried.
	retries: number,
	heartbeats: number,
}

local DEFAULTS = {
	apiKeySecret = "gamepulse_api_key",
	flushInterval = 10,
	maxBatchSize = 50,
	maxBufferSize = 5000,
	heartbeatInterval = 60,
	maxRequestsPerMinute = 60,
	trackPlayers = true,
	bindToClose = true,
	shutdownTimeout = 25,
	compress = true,
	backoffBase = 1,
	backoffMax = 60,
	debug = false,
}

local function log(...: any)
	print("[GamePulse]", ...)
end

local function warnf(...: any)
	warn("[GamePulse]", ...)
end

local function withDefaults(config: Config): { [string]: any }
	local merged: { [string]: any } = table.clone(DEFAULTS)
	for k, v in config :: any do
		merged[k] = v
	end
	return merged
end

-- The key lives in an experience secret, not in the place file. The secret object
-- can be put straight into a request header; its value is never visible to Luau.
local function resolveApiKey(config: { [string]: any }): any
	if config.apiKey then
		if not RunService:IsStudio() then
			warnf("apiKey is set in code. Store it in an experience secret and use apiKeySecret instead.")
		end
		return config.apiKey
	end
	local ok, secret = pcall(function()
		return HttpService:GetSecret(config.apiKeySecret)
	end)
	if not ok then
		error(
			`[GamePulse] couldn't read the experience secret "{config.apiKeySecret}": {secret}. `
				.. "Add it under Game Settings > Security > Secrets, or pass apiKey when testing in Studio.",
			0
		)
	end
	return secret
end

-- Retry-After is either seconds or an HTTP date. We only send seconds from our API.
local function retryAfterSeconds(headers: { [string]: any }?): number?
	if not headers then
		return nil
	end
	for name, value in headers do
		if string.lower(name) == "retry-after" then
			return tonumber(value)
		end
	end
	return nil
end

--- Creates a client and starts its background sender.
function GamePulse.start(config: Config)
	local self = GamePulse.new(config)
	self:_start()
	return self
end

function GamePulse.new(config: Config)
	assert(RunService:IsServer(), "[GamePulse] must run on the server (a Script or ModuleScript in ServerScriptService)")
	assert(type(config) == "table", "[GamePulse] config is required")
	assert(Validate.gameId(config.gameId), "[GamePulse] gameId must be a lowercase slug like \"my-obby\"")
	assert(type(config.endpoint) == "string", "[GamePulse] endpoint is required, e.g. \"https://ingest.example.com\"")

	local cfg = withDefaults(config)
	assert(cfg.maxBatchSize >= 1 and cfg.maxBatchSize <= API_MAX_BATCH, "[GamePulse] maxBatchSize must be 1-100")

	local clock: () -> number = cfg.clock or os.clock
	local self = setmetatable({
		_config = cfg,
		_endpoint = string.gsub(cfg.endpoint, "/+$", ""),
		_apiKey = resolveApiKey(cfg),
		_transport = cfg.transport or function(request)
			return HttpService:RequestAsync(request)
		end,
		_clock = clock,
		-- In a live server JobId identifies it. In Studio it's "", so make one up.
		_serverId = if game.JobId ~= "" then game.JobId else HttpService:GenerateGUID(false),
		_queue = EventQueue.new(cfg.maxBufferSize),
		_budget = RequestBudget.new(cfg.maxRequestsPerMinute, clock),
		-- The batch being sent. It stays here until the API accepts it or refuses it,
		-- so a retry sends the same events in the same order.
		_pending = nil :: { any }?,
		_attempts = 0,
		_retryAt = 0,
		_lastFlush = clock(),
		_lastContact = clock(),
		_flushRequested = false,
		_running = false,
		_closing = false,
		_closed = false,
		_deadline = math.huge,
		_present = {} :: { [number]: boolean },
		_connections = {} :: { RBXScriptConnection },
		_lastDropWarning = -math.huge,
		_stats = { queued = 0, dropped = 0, sent = 0, rejected = 0, retries = 0, heartbeats = 0 } :: Stats,
	}, GamePulse)
	return self
end

function GamePulse._start(self: any)
	if not self._config.transport then
		local ok, enabled = pcall(function()
			return HttpService.HttpEnabled
		end)
		if ok and not enabled then
			warnf("HTTP requests are disabled. Turn on Game Settings > Security > Allow HTTP Requests.")
		end
	end

	if self._config.trackPlayers then
		-- Players who joined before the SDK started never fire PlayerAdded for us.
		for _, player in Players:GetPlayers() do
			self:_playerJoined(player)
		end
		table.insert(self._connections, Players.PlayerAdded:Connect(function(player)
			self:_playerJoined(player)
		end))
		table.insert(self._connections, Players.PlayerRemoving:Connect(function(player)
			self:_playerLeft(player.UserId)
		end))
	end

	if self._config.bindToClose then
		game:BindToClose(function()
			self:shutdown()
		end)
	end

	self._running = true
	task.spawn(function()
		local ok, err = pcall(self._run, self)
		self._running = false
		if not ok then
			warnf("sender stopped unexpectedly:", err)
		end
	end)
end

-- Public API -------------------------------------------------------------------

--- A custom event. `player` is a Player or a UserId.
function GamePulse.track(self: any, name: string, player: Player | number, properties: { [string]: any }?)
	local ok, err = Validate.eventName(name)
	if not ok then
		return self:_reject(`track("{tostring(name)}"): {err}`)
	end
	self:_enqueue("custom", player, properties or {}, { name = name })
end

--- A purchase. Pass `purchaseId` (the receipt's PurchaseId) whenever you have it:
--- it makes the event idempotent, so a receipt processed twice counts once.
function GamePulse.trackPurchase(
	self: any,
	player: Player | number,
	productId: string | number,
	robux: number,
	properties: { [string]: any }?,
	purchaseId: string?
)
	local okProduct, productErr = Validate.productId(productId)
	if not okProduct then
		return self:_reject(`trackPurchase: {productErr}`)
	end
	local okRobux, robuxErr = Validate.robux(robux)
	if not okRobux then
		return self:_reject(`trackPurchase: {robuxErr}`)
	end
	local props = table.clone(properties or {})
	props.product_id = productId
	props.robux = robux
	local extra = {}
	if purchaseId then
		props.purchase_id = purchaseId
		extra.event_id = Guid.fromString(`purchase:{purchaseId}`)
	end
	self:_enqueue("purchase", player, props, extra)
end

--- Tracks the purchase described by a ProcessReceipt receiptInfo.
function GamePulse.trackReceipt(self: any, receiptInfo: { [string]: any }, properties: { [string]: any }?)
	self:trackPurchase(
		receiptInfo.PlayerId,
		receiptInfo.ProductId,
		receiptInfo.CurrencySpent,
		properties,
		receiptInfo.PurchaseId
	)
end

--- Sends whatever is buffered now instead of waiting for the next interval.
function GamePulse.flush(self: any)
	self._flushRequested = true
end

function GamePulse.getStats(self: any): Stats
	local stats = table.clone(self._stats)
	stats.queued = self._queue:size() + (if self._pending then #self._pending else 0)
	return stats
end

--- Sends everything still buffered, then stops. Called automatically on
--- BindToClose. Yields until done or `timeout` seconds have passed.
function GamePulse.shutdown(self: any, timeout: number?)
	if self._closing then
		return
	end
	-- Players still here when the server closes may never fire PlayerRemoving
	-- before we're gone, so close their sessions now.
	for userId in self._present do
		self:_playerLeft(userId)
	end
	self._closing = true
	self._deadline = self._clock() + (timeout or self._config.shutdownTimeout)
	-- A long backoff would make us miss the deadline; try again almost at once.
	self._retryAt = math.min(self._retryAt, self._clock() + 1)

	while self._running do
		task.wait(0.05)
	end
	for _, connection in self._connections do
		connection:Disconnect()
	end
	self._closed = true

	local lost = self._queue:size() + (if self._pending then #self._pending else 0)
	if lost > 0 then
		warnf(`shut down with {lost} events unsent`)
	elseif self._config.debug then
		log("shut down, all events sent")
	end
end

-- Internals ----------------------------------------------------------------------

function GamePulse._playerJoined(self: any, player: Player)
	if self._present[player.UserId] then
		return
	end
	self._present[player.UserId] = true
	self:_enqueue("player_join", player, {}, {})
end

function GamePulse._playerLeft(self: any, userId: number)
	if not self._present[userId] then
		return
	end
	self._present[userId] = nil
	self:_enqueue("player_leave", userId, {}, {})
end

function GamePulse._reject(self: any, message: string)
	self._stats.rejected += 1
	warnf(message)
end

function GamePulse._enqueue(self: any, eventType: string, player: Player | number, properties: { [string]: any }, extra: { [string]: any })
	if self._closed then
		return
	end
	local userId = if typeof(player) == "Instance" then (player :: Player).UserId else player
	local okPlayer, playerErr = Validate.playerId(userId)
	if not okPlayer then
		return self:_reject(`{eventType}: {playerErr}`)
	end
	local okProps, propsErr = Validate.properties(properties)
	if not okProps then
		return self:_reject(`{eventType}: {propsErr}`)
	end

	local event = {
		event_id = extra.event_id or HttpService:GenerateGUID(false),
		game_id = self._config.gameId,
		server_id = self._serverId,
		player_id = userId,
		type = eventType,
		name = extra.name,
		timestamp = DateTime.now().UnixTimestampMillis,
		-- An empty Luau table encodes as [] (an array), which the API would reject;
		-- leave it out and the API defaults it to {}.
		properties = if next(properties) ~= nil then properties else nil,
	}
	if self._queue:push(event) then
		self._stats.dropped += 1
		local now = self._clock()
		if now - self._lastDropWarning > 60 then
			self._lastDropWarning = now
			warnf(`buffer full ({self._config.maxBufferSize} events), dropping the oldest`)
		end
	end
end

-- The sender: the only thread that makes requests. One request at a time keeps
-- batches in order, which the worker relies on to pair joins with leaves.
function GamePulse._run(self: any)
	local cfg = self._config
	while true do
		local now = self._clock()
		local queued = self._queue:size()
		if self._closing and (now >= self._deadline or (self._pending == nil and queued == 0)) then
			return
		end

		local sent = false
		if now >= self._retryAt then
			if self._pending == nil and queued > 0 then
				local due = self._closing
					or self._flushRequested
					or queued >= cfg.maxBatchSize
					or now - self._lastFlush >= cfg.flushInterval
				if due then
					self._pending = self._queue:take(if self._closing then API_MAX_BATCH else cfg.maxBatchSize)
					self._lastFlush = now
					self._flushRequested = false
				end
			end

			if self._pending then
				-- At shutdown there's no "later" to save budget for.
				if self._closing or self._budget:take() then
					self:_sendPending()
					sent = true
				end
			elseif not self._closing and now - self._lastContact >= cfg.heartbeatInterval and self._budget:take() then
				self:_sendHeartbeat()
				sent = true
			end
		end

		-- After a send, go straight round again in case more is waiting.
		if sent then
			task.wait()
		else
			task.wait(math.min(0.25, cfg.flushInterval / 4))
		end
	end
end

-- "ok", "retry" or "drop", plus Retry-After and an error message.
function GamePulse._post(self: any, path: string, body: any): (string, number?, string?)
	local request = {
		Url = self._endpoint .. path,
		Method = "POST",
		Headers = { ["Content-Type"] = "application/json", ["X-API-Key"] = self._apiKey },
		Body = HttpService:JSONEncode(body),
		Compress = if self._config.compress then Enum.HttpCompression.Gzip else Enum.HttpCompression.None,
	}
	local ok, response = pcall(self._transport, request)
	if not ok then
		-- Network error, DNS, or HttpService's own per-server limit. All transient.
		return "retry", nil, tostring(response)
	end
	if response.Success then
		return "ok"
	end
	local status = response.StatusCode
	local message = `HTTP {status}: {string.sub(response.Body or "", 1, 300)}`
	-- 429 = slow down, 5xx = our side's problem, 408 = timed out: try again later.
	if status == 429 or status == 408 or status >= 500 then
		return "retry", retryAfterSeconds(response.Headers), message
	end
	-- Any other 4xx means the request itself is wrong. Sending it again gives
	-- the same answer, and would block every event queued behind it.
	return "drop", nil, message
end

function GamePulse._backoff(self: any, retryAfter: number?): number
	self._attempts += 1
	self._stats.retries += 1
	if retryAfter then
		return retryAfter
	end
	-- Full jitter: a random wait up to the exponential cap, so many servers that
	-- failed at the same moment don't all retry at the same moment too.
	local cap = math.min(self._config.backoffMax, self._config.backoffBase * 2 ^ (self._attempts - 1))
	return math.random() * cap
end

function GamePulse._sendPending(self: any)
	local batch = self._pending
	local result, retryAfter, err = self:_post("/v1/events", { events = batch })
	local now = self._clock()
	if result == "ok" then
		self._stats.sent += #batch
		self._pending = nil
		self._attempts = 0
		self._lastContact = now
		if self._config.debug then
			log(`sent {#batch} events`)
		end
	elseif result == "drop" then
		self._stats.rejected += #batch
		self._pending = nil
		self._attempts = 0
		warnf(`the API refused a batch of {#batch} events, dropping it. {err}`)
	else
		local delay = self:_backoff(retryAfter)
		self._retryAt = now + delay
		if self._config.debug or self._attempts >= 3 then
			warnf(`send failed (attempt {self._attempts}), retrying in {string.format("%.1f", delay)}s. {err}`)
		end
	end
end

function GamePulse._sendHeartbeat(self: any)
	local result, retryAfter, err = self:_post("/v1/heartbeat", {
		game_id = self._config.gameId,
		server_id = self._serverId,
		players = #Players:GetPlayers(),
	})
	local now = self._clock()
	if result == "ok" then
		self._stats.heartbeats += 1
		self._attempts = 0
		self._lastContact = now
	elseif result == "retry" then
		self._retryAt = now + self:_backoff(retryAfter)
	else
		-- A refused heartbeat (say, a revoked key) won't get better; don't hammer the API.
		self._lastContact = now
		warnf(`heartbeat refused. {err}`)
	end
end

return GamePulse
