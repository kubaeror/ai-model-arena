import { InMemoryQueue } from './in-memory.js';
import { RedisStreamQueue } from './redis.js';
import { loadRedisQueueConfig } from './redis-config.js';
import type { TaskQueue } from './types.js';

export function createQueue(provider?: string): TaskQueue {
  const driver = process.env.QUEUE_DRIVER ?? 'memory';
  if (driver === 'redis') {
    const config = loadRedisQueueConfig();
    // Dashboard reads per-provider streams; the runner's provider comes from
    // ARENA_PROVIDER_FILTER in the environment when no explicit provider is given.
    if (provider) config.providerFilter = provider;
    return new RedisStreamQueue(config);
  }
  if (driver === 'memory') return new InMemoryQueue();
  throw new Error(`Unknown QUEUE_DRIVER: ${driver}`);
}

export type { TaskQueue, Task } from './types.js';
