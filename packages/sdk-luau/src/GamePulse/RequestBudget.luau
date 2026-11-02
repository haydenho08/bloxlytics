--!strict
-- A token bucket that keeps the SDK under its share of HttpService's limit.
--
-- Roblox allows each game server about 500 HTTP requests per minute, shared by
-- every script in the game. Analytics must never starve the game's own requests
-- (say, a Discord webhook or a matchmaking service), so the SDK holds itself to a
-- budget well below that. The same algorithm as the API's rate limiter (Stage 1),
-- just running inside the game server.

local RequestBudget = {}
RequestBudget.__index = RequestBudget

export type RequestBudget = typeof(setmetatable(
	{} :: {
		perMinute: number,
		tokens: number,
		updatedAt: number,
		clock: () -> number,
	},
	RequestBudget
))

function RequestBudget.new(perMinute: number, clock: () -> number): RequestBudget
	return setmetatable({ perMinute = perMinute, tokens = perMinute, updatedAt = clock(), clock = clock }, RequestBudget)
end

--- Spends one request if there's budget for it.
function RequestBudget.take(self: RequestBudget): boolean
	local now = self.clock()
	self.tokens = math.min(self.perMinute, self.tokens + (now - self.updatedAt) * self.perMinute / 60)
	self.updatedAt = now
	if self.tokens >= 1 then
		self.tokens -= 1
		return true
	end
	return false
end

return RequestBudget
