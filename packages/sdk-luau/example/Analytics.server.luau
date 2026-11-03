-- Example: wiring Bloxlytics into a game.
--
-- Joins and leaves are tracked automatically. This script adds a custom event
-- (touching the green Checkpoint part) and shows where purchases go.
--
-- Settings come from attributes on this script, so nothing is hard-coded:
--   Endpoint  the API's URL. http://localhost:8080 when testing in Studio.
--   ApiKey    Studio testing ONLY. In a published game leave it empty and put
--             the key in the experience secret "bloxlytics_api_key" instead.

local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local ServerScriptService = game:GetService("ServerScriptService")

local Bloxlytics = require(ServerScriptService.Bloxlytics)

local apiKey = script:GetAttribute("ApiKey")
local analytics = Bloxlytics.start({
	gameId = script:GetAttribute("GameId") or "my-obby",
	endpoint = script:GetAttribute("Endpoint") or "http://localhost:8080",
	apiKey = if apiKey ~= nil and apiKey ~= "" then apiKey else nil,
	debug = true,
})

-- A custom event: once per player per checkpoint.
local reached: { [number]: boolean } = {}
local checkpoint = workspace:WaitForChild("Checkpoint")
checkpoint.Touched:Connect(function(hit)
	local player = Players:GetPlayerFromCharacter(hit.Parent)
	if player and not reached[player.UserId] then
		reached[player.UserId] = true
		analytics:track("checkpoint_reached", player, { checkpoint = checkpoint.Name, seconds_in_game = math.floor(time()) })
	end
end)
Players.PlayerRemoving:Connect(function(player)
	reached[player.UserId] = nil
end)

-- Purchases: track inside ProcessReceipt. trackReceipt derives the event id from
-- the receipt's PurchaseId, so if Roblox calls this twice for one purchase (it
-- does, until you return PurchaseGranted) revenue is still counted once.
-- A game may have only one ProcessReceipt; if yours already has one, add the
-- trackReceipt line to it instead.
MarketplaceService.ProcessReceipt = function(receiptInfo)
	-- ... grant the item here first ...
	analytics:trackReceipt(receiptInfo)
	return Enum.ProductPurchaseDecision.PurchaseGranted
end
