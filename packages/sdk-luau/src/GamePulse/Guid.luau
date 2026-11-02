--!strict
-- Deterministic GUIDs: the same input string always gives the same GUID.
--
-- Used for purchases. Roblox calls ProcessReceipt again for the same purchase
-- until the game returns PurchaseGranted, and again after a server crash, so the
-- game can easily track one purchase twice. If both events share an event_id
-- derived from the receipt's PurchaseId, the worker's ON CONFLICT DO NOTHING
-- keeps only one, and revenue isn't double counted.
--
-- Four 32-bit FNV-1a hashes with different starting values give 128 bits. FNV
-- isn't cryptographic, which is fine: we only need equal inputs to give equal
-- outputs and different purchases to (practically) never collide.

local Guid = {}

local FNV_OFFSETS = { 0x811C9DC5, 0x050C5D1F, 0x2D2B4F37, 0x6F7B8A9D }

-- Multiply by the FNV prime (2^24 + 403) modulo 2^32 without losing precision:
-- x * 16777619 can exceed 2^53, where Luau's doubles stop being exact integers.
local function timesPrime(x: number): number
	return (bit32.lshift(x, 24) + x * 403) % 4294967296
end

local function fnv1a(s: string, offset: number): number
	local h = offset
	for i = 1, #s do
		h = timesPrime(bit32.bxor(h, string.byte(s, i)))
	end
	return h
end

--- A GUID (lower case, 8-4-4-4-12) derived from s.
function Guid.fromString(s: string): string
	local w1, w2, w3, w4 = fnv1a(s, FNV_OFFSETS[1]), fnv1a(s, FNV_OFFSETS[2]), fnv1a(s, FNV_OFFSETS[3]), fnv1a(s, FNV_OFFSETS[4])
	-- Mark it as version 8 ("custom") with the standard variant bits, like a real UUID.
	w2 = bit32.bor(bit32.band(w2, 0xFFFF0FFF), 0x00008000)
	w3 = bit32.bor(bit32.band(w3, 0x3FFFFFFF), 0x80000000)
	local hex = string.format("%08x%08x%08x%08x", w1, w2, w3, w4)
	return string.format(
		"%s-%s-%s-%s-%s",
		hex:sub(1, 8),
		hex:sub(9, 12),
		hex:sub(13, 16),
		hex:sub(17, 20),
		hex:sub(21, 32)
	)
end

return Guid
