import { InMemoryQueue } from './in-memory.js';
import { RedisStreamQueue } from './redis.js';
import { loadRedisQueueConfig } from './redis-config.js';
import type { TaskQueue } from './types.js';

export function createQueue(): TaskQueue {
  const driver = process.env.QUEUE_DRIVER ?? 'memory';
  if (driver === 'redis') {
    return new RedisStreamQueue(loadRedisQueueConfig());
  }
  if (driver === 'memory') return new InMemoryQueue();
  throw new Error(`Unknown QUEUE_DRIVER: ${driver}`);
}

export type { TaskQueue, Task } from './types.js';
