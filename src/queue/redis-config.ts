import os from 'node:os';
import { z } from 'zod/v4';
import { DEFAULT_MAX_ATTEMPTS } from './types.js';

const RedisQueueConfigSchema = z.object({
  url: z.string(),
  streamPrefix: z.string().default('arena:tasks'),
  consumerGroup: z.string().default('arena-runners'),
  consumerName: z.string().default(os.hostname()),
  maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_MAX_ATTEMPTS),
  retryBackoffMs: z.number().int().min(50).max(60_000).default(2_000),
  reclaimIdleMs: z.number().int().min(1_000).max(600_000).default(60_000),
  reclaimIntervalMs: z.number().int().min(1_000).max(300_000).default(30_000),
  providerFilter: z.string().optional(),
});

export type RedisQueueConfig = z.infer<typeof RedisQueueConfigSchema>;

export function loadRedisQueueConfig(): RedisQueueConfig {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required when QUEUE_DRIVER=redis');

  const raw = {
    url,
    streamPrefix: process.env.REDIS_STREAM_PREFIX ?? 'arena:tasks',
    consumerGroup: process.env.REDIS_CONSUMER_GROUP ?? 'arena-runners',
    consumerName: process.env.REDIS_CONSUMER_NAME ?? os.hostname(),
    maxAttempts: Number(process.env.MAX_TASK_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS),
    retryBackoffMs: Number(process.env.REDIS_RETRY_BACKOFF_MS ?? 2_000),
    reclaimIdleMs: Number(process.env.REDIS_RECLAIM_IDLE_MS ?? 60_000),
    reclaimIntervalMs: Number(process.env.REDIS_RECLAIM_INTERVAL_MS ?? 30_000),
    providerFilter: process.env.ARENA_PROVIDER_FILTER ?? undefined,
  };

  return RedisQueueConfigSchema.parse(raw);
}
