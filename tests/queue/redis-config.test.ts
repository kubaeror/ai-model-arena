import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { loadRedisQueueConfig } from '../../src/queue/redis-config.js';

const ENV_KEYS = [
  'REDIS_URL',
  'REDIS_STREAM_PREFIX',
  'REDIS_CONSUMER_GROUP',
  'REDIS_CONSUMER_NAME',
  'MAX_TASK_ATTEMPTS',
  'REDIS_RETRY_BACKOFF_MS',
  'REDIS_RECLAIM_IDLE_MS',
  'REDIS_RECLAIM_INTERVAL_MS',
  'ARENA_PROVIDER_FILTER',
];

function saveEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
}

test('loadRedisQueueConfig throws without REDIS_URL', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  assert.throws(() => loadRedisQueueConfig(), /REDIS_URL is required/);
});

test('loadRedisQueueConfig applies defaults when only REDIS_URL set', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.REDIS_URL = 'redis://localhost:6379';
  const cfg = loadRedisQueueConfig();
  assert.equal(cfg.streamPrefix, 'arena:tasks');
  assert.equal(cfg.consumerGroup, 'arena-runners');
  assert.equal(cfg.consumerName, os.hostname());
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.retryBackoffMs, 2_000);
  assert.equal(cfg.reclaimIdleMs, 60_000);
  assert.equal(cfg.reclaimIntervalMs, 30_000);
  assert.equal(cfg.providerFilter, undefined);
});

test('parsed config has no dead blockMs field', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.REDIS_URL = 'redis://localhost:6379';
  const cfg = loadRedisQueueConfig();
  assert.equal('blockMs' in (cfg as Record<string, unknown>), false);
});

test('loadRedisQueueConfig reads explicit env overrides', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.REDIS_STREAM_PREFIX = 'arena:tasks:custom';
  process.env.REDIS_CONSUMER_GROUP = 'cg';
  process.env.REDIS_CONSUMER_NAME = 'cn';
  process.env.MAX_TASK_ATTEMPTS = '7';
  process.env.REDIS_RETRY_BACKOFF_MS = '2500';
  process.env.REDIS_RECLAIM_IDLE_MS = '5000';
  process.env.REDIS_RECLAIM_INTERVAL_MS = '2000';
  process.env.ARENA_PROVIDER_FILTER = 'anthropic';
  assert.deepEqual(loadRedisQueueConfig(), {
    url: 'redis://localhost:6379',
    streamPrefix: 'arena:tasks:custom',
    consumerGroup: 'cg',
    consumerName: 'cn',
    maxAttempts: 7,
    retryBackoffMs: 2500,
    reclaimIdleMs: 5000,
    reclaimIntervalMs: 2000,
    providerFilter: 'anthropic',
  });
});

test('loadRedisQueueConfig rejects out-of-range maxAttempts', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.MAX_TASK_ATTEMPTS = '0';
  assert.throws(() => loadRedisQueueConfig(), /maxAttempts/);
});

test('loadRedisQueueConfig rejects out-of-range retryBackoffMs', (t) => {
  t.after(saveEnv());
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.REDIS_RETRY_BACKOFF_MS = '10';
  assert.throws(() => loadRedisQueueConfig(), /retryBackoffMs/);
});
