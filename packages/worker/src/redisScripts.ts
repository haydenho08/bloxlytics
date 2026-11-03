import type { Redis, Result } from "ioredis";

/**
 * Deletes the stream entries every consumer group has acknowledged.
 * KEYS[1] = stream. Returns the number of entries deleted.
 *
 * Why it's needed: the API's backpressure check counts XLEN, and XACK doesn't
 * delete anything, so without this the stream (and XLEN) grows forever and the
 * API starts refusing batches even when nothing is waiting.
 *
 * For each group, everything before a safe point is done:
 *   - the oldest entry still pending (delivered, not yet acknowledged), or
 *   - if nothing is pending, the entry just after the last one delivered.
 * The smallest safe point over all groups is passed to XTRIM MINID, which deletes
 * entries with smaller IDs. Run as a script so no entry can be delivered or
 * acknowledged between reading the groups and trimming.
 */
const TRIM_ACKED = `
local function parse(id)
  local ms, seq = string.match(id, '^(%d+)-(%d+)$')
  return tonumber(ms), tonumber(seq)
end
local function less(a, b)
  local ams, aseq = parse(a)
  local bms, bseq = parse(b)
  return ams < bms or (ams == bms and aseq < bseq)
end

local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
if #groups == 0 then return 0 end

local safe = nil
for _, g in ipairs(groups) do
  local info = {}
  for i = 1, #g, 2 do info[g[i]] = g[i + 1] end
  local point
  if tonumber(info['pending']) > 0 then
    point = redis.call('XPENDING', KEYS[1], info['name'])[2]
  else
    local ms, seq = string.match(info['last-delivered-id'], '^(%d+)-(%d+)$')
    point = ms .. '-' .. (tonumber(seq) + 1)
  end
  if safe == nil or less(point, safe) then safe = point end
end
return redis.call('XTRIM', KEYS[1], 'MINID', safe)
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    bxTrimAcked(stream: string): Result<number, Context>;
  }
}

export function defineScripts(redis: Redis): void {
  redis.defineCommand("bxTrimAcked", { numberOfKeys: 1, lua: TRIM_ACKED });
}
