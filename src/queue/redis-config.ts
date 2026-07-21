import os from 'node:os';

export interface RedisQueueConfig {
  url: string;
  streamPrefix: string;
  consumerGroup: string;
  consumerName: string;
  maxAttempts: number;
  blockMs: number;
  providerFilter?: string;
}

export function loadRedisQueueConfig(): RedisQueueConfig {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required when QUEUE_DRIVER=redis');
  return {
    url,
    streamPrefix: process.env.REDIS_STREAM_PREFIX ?? 'arena:tasks',
    consumerGroup: process.env.REDIS_CONSUMER_GROUP ?? 'arena-runners',
    consumerName: process.env.REDIS_CONSUMER_NAME ?? os.hostname(),
    maxAttempts: Number(process.env.MAX_TASK_ATTEMPTS ?? 5),
    blockMs: Number(process.env.REDIS_BLOCK_MS ?? 5000),
    providerFilter: process.env.ARENA_PROVIDER_FILTER ?? undefined,
  };
}
