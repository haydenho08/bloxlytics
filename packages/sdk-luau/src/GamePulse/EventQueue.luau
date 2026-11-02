--!strict
-- A bounded first-in-first-out queue of events.
--
-- When it's full, adding an event drops the *oldest* one. During a long outage
-- the newest data is the most useful, and a game server's memory is shared with
-- the game itself, so the buffer must never grow without limit.
--
-- Stored as a table with head/tail indices instead of table.remove(t, 1), which
-- shifts every element and makes taking from the front O(n).

local EventQueue = {}
EventQueue.__index = EventQueue

export type EventQueue = typeof(setmetatable(
	{} :: {
		items: { [number]: any },
		head: number,
		tail: number,
		capacity: number,
		dropped: number,
	},
	EventQueue
))

function EventQueue.new(capacity: number): EventQueue
	assert(capacity >= 1, "capacity must be at least 1")
	return setmetatable({ items = {}, head = 1, tail = 0, capacity = capacity, dropped = 0 }, EventQueue)
end

function EventQueue.size(self: EventQueue): number
	return self.tail - self.head + 1
end

--- Adds an item at the back. Returns true if the oldest item was dropped to make room.
function EventQueue.push(self: EventQueue, item: any): boolean
	local dropped = false
	if self:size() >= self.capacity then
		self.items[self.head] = nil
		self.head += 1
		self.dropped += 1
		dropped = true
	end
	self.tail += 1
	self.items[self.tail] = item
	return dropped
end

--- Removes and returns up to n items from the front, oldest first.
function EventQueue.take(self: EventQueue, n: number): { any }
	local out = {}
	while #out < n and self:size() > 0 do
		table.insert(out, self.items[self.head])
		self.items[self.head] = nil
		self.head += 1
	end
	return out
end

return EventQueue
