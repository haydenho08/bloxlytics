import { Redis } from "ioredis";

/**
 * Fail fast instead of queueing. By default ioredis buffers commands while
 * disconnected and retries them, so if Redis goes down every request hangs.
 * We'd rather answer 503 straight away and let the SDK retry with backoff.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}
