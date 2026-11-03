--!strict
-- Checks events before they're buffered, mirroring the API's rules.
--
-- The API rejects a whole batch if one event is bad (400), and the SDK doesn't
-- retry 400s, so one bad event would cost the 49 good ones sent with it. Catching
-- it here costs only that event, and the warning points at the line that made it.

local HttpService = game:GetService("HttpService")

local Validate = {}

local MAX_PROPERTIES_BYTES = 8 * 1024
local MAX_KEY_LENGTH = 64
local MAX_DEPTH = 10
-- Above 2^53 doubles can't represent every integer, and the API refuses them.
local MAX_SAFE_INTEGER = 9007199254740991

function Validate.gameId(id: any): boolean
	return type(id) == "string" and #id <= 64 and string.match(id, "^[a-z0-9][a-z0-9_%-]*$") ~= nil
end

function Validate.eventName(name: any): (boolean, string?)
	if type(name) ~= "string" or #name < 1 or #name > 64 or not string.match(name, "^[%w_%.:%-]+$") then
		return false, "event name must be 1-64 characters of letters, digits, _ . : -"
	end
	return true
end

function Validate.playerId(id: any): (boolean, string?)
	if type(id) ~= "number" or id ~= math.floor(id) or id < 1 or id > MAX_SAFE_INTEGER then
		-- Studio's "local server" test players have negative UserIds.
		return false, `player id must be a positive integer (got {tostring(id)}; Studio test players have negative ids)`
	end
	return true
end

-- JSON can't express NaN, infinity, Instances, functions or Vector3s, and
-- JSONEncode turns some of them into output the API can't parse.
local function checkValue(value: any, path: string, depth: number): string?
	local kind = type(value)
	if kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			return `{path} is not a finite number`
		end
	elseif kind == "table" then
		if depth > MAX_DEPTH then
			return `{path} is nested too deeply`
		end
		for k, v in value do
			local err = checkValue(v, `{path}.{tostring(k)}`, depth + 1)
			if err then
				return err
			end
		end
	elseif kind ~= "string" and kind ~= "boolean" then
		return `{path} is a {typeof(value)}, which can't be sent as JSON`
	end
	return nil
end

--- properties must be a dictionary of JSON values that encodes to at most 8 KiB.
function Validate.properties(props: any): (boolean, string?)
	if type(props) ~= "table" then
		return false, "properties must be a table"
	end
	for k in props do
		-- An array-like table encodes as a JSON array, but the API wants an object.
		if type(k) ~= "string" or #k > MAX_KEY_LENGTH then
			return false, `properties keys must be strings of at most {MAX_KEY_LENGTH} characters (got {tostring(k)})`
		end
	end
	local err = checkValue(props, "properties", 0)
	if err then
		return false, err
	end
	local ok, encoded = pcall(HttpService.JSONEncode, HttpService, props)
	if not ok then
		return false, `properties can't be encoded as JSON: {encoded}`
	end
	if #encoded > MAX_PROPERTIES_BYTES then
		return false, `properties encode to {#encoded} bytes; the limit is {MAX_PROPERTIES_BYTES}`
	end
	return true
end

function Validate.robux(robux: any): (boolean, string?)
	if type(robux) ~= "number" or robux ~= math.floor(robux) or robux < 0 then
		return false, "robux must be a whole number of at least 0"
	end
	return true
end

function Validate.productId(id: any): (boolean, string?)
	if type(id) == "number" and id == math.floor(id) and id >= 0 then
		return true
	end
	if type(id) == "string" and #id >= 1 and #id <= 64 then
		return true
	end
	return false, "product id must be a whole number or a string of 1-64 characters"
end

return Validate
