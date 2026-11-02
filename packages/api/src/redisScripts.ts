import type { Redis, Result } from "ioredis";

// Both scripts run inside Redis as a single atomic step. Nothing else can touch
// the keys between the read and the write, so there are no check-then-act races
// even with many API instances sharing one Redis.

/**
 * Token bucket. KEYS[1] = bucket hash. ARGV = rate (tokens/sec), burst, cost.
 * Returns {allowed (0|1), retry_after_ms, tokens_left}.
 *
 * Uses Redis's own clock (TIME) rather than each API server's, so instances with
 * slightly different clocks can't disagree about how many tokens have refilled.
 */
const TAKE_TOKENS = `
local rate  = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost  = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])
if tokens == nil then
  tokens = burst
  ts = now
end

tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)

local allowed, retry_ms = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
-- An idle bucket refills to full after burst/rate seconds; after that it's
-- indistinguishable from a missing key, so let Redis clean it up.
redis.call('PEXPIRE', KEYS[1], math.ceil(burst * 1000 / rate) + 1000)
return {allowed, retry_ms, math.floor(tokens)}
`;

/**
 * Backpressure check + enqueue. KEYS[1] = stream. ARGV[1] = max pending,
 * ARGV[2] = field name (what kind of entry), ARGV[3..n] = one JSON entry each.
 * Returns the number added, or -1 if the stream is too full (nothing is added
 * in that case).
 *
 * All-or-nothing: a batch is never half-enqueued, so a retry after an error
 * can't leave the first half of a batch in twice and the second half missing.
 */
const ENQUEUE = `
local count = #ARGV - 2
if redis.call('XLEN', KEYS[1]) + count > tonumber(ARGV[1]) then
  return -1
end
for i = 3, #ARGV do
  redis.call('XADD', KEYS[1], '*', ARGV[2], ARGV[i])
end
return count
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    gpTakeTokens(
      key: string,
      rate: number,
      burst: number,
      cost: number,
    ): Result<[number, number, number], Context>;
    gpEnqueue(stream: string, maxPending: number, field: string, ...entries: string[]): Result<number, Context>;
  }
}

/** Registers the scripts. ioredis sends EVALSHA and falls back to EVAL on a cache miss. */
export function defineScripts(redis: Redis): void {
  redis.defineCommand("gpTakeTokens", { numberOfKeys: 1, lua: TAKE_TOKENS });
  redis.defineCommand("gpEnqueue", { numberOfKeys: 1, lua: ENQUEUE });
}
