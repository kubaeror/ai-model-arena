/**
 * Redis-backed rate limiter for multi-instance deployments.
 *
 * When QUEUE_DRIVER=redis, the rate limiter uses Redis to share counters
 * across dashboard instances. In SQLite/in-memory mode, the existing
 * in-memory Map-based limiter is used (checkRateLimit in auth-api.ts).
 */

const KEY_PREFIX = 'arena:ratelimit:api:';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

/**
 * Attempt to consume one token from a sliding-window rate limit bucket.
 * Uses Redis with a Lua script to atomically check + increment.
 * Returns the same shape as checkRateLimit() so it can be drop-in.
 */
export async function redisCheckRateLimit(
  keyName: string,
  maxTokens: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const { createQueue } = await import('../queue/index.js');
  const { getSharedRedisClient } = await import('../queue/redis.js');
  // Side-effect: registers the shared ioredis client (keyed by REDIS_URL) in
  // the queue module when QUEUE_DRIVER=redis, mirroring the previous direct
  // access of the queue's private client.
  createQueue();

  // Access the underlying Redis client for rate limiting.
  // The RedisStreamQueue registers a shared ioredis client per config URL;
  // we look it up here instead of reaching into the queue instance.
  try {
    const redis = getSharedRedisClient(process.env.REDIS_URL ?? '');
    if (!redis) throw new Error('no redis client');

    const now = Date.now();
    const windowStart = now - windowMs;
    const key = `${KEY_PREFIX}${keyName}:${Math.floor(now / windowMs)}`;

    // LUA: atomically remove old entries, check count, increment
    const lua = `
      local key = KEYS[1]
      local max = tonumber(ARGV[1])
      local window_start = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
      local count = redis.call('ZCARD', key)
      if count >= max then
        return {0, max - count, math.floor((redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2] or 0) / 1000) * 1000 + tonumber(ARGV[4]) - now}
      end
      redis.call('ZADD', key, now, now .. '-' .. count)
      redis.call('EXPIRE', key, math.ceil(tonumber(ARGV[4]) / 1000) + 1)
      count = count + 1
      return {1, max - count, 0}
    `;

    const result = await redis.eval(
      lua,
      1,
      key,
      maxTokens,
      windowStart,
      now,
      windowMs,
    ) as [number, number, number];

    const allowed = result[0] === 1;
    const remaining = Math.max(0, result[1] ?? 0);
    const resetIn = result[2] ?? 0;

    return { allowed, remaining, resetIn };
  } catch {
    // Throw so callers fall back to the in-memory rate limiter (auth-api.ts:checkRateLimit).
    // Failing-open would allow unbounded traffic during a Redis outage.
    throw new Error('Redis rate limiter unavailable');
  }
}
