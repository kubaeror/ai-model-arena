import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheMetrics } from '../../src/metrics/cache-metrics.js';
import {
  taskCounter,
  taskDuration,
  activeTasks,
  queueDepth,
  scheduleFailures,
  metricsHandler,
} from '../../src/observability/metrics.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';

async function scrapeMetrics(): Promise<string> {
  let body = '';
  const res = {
    set: () => {},
    end: (b: string) => { body = b; },
  };
  await metricsHandler(null, res as { set: (k: string, v: string) => void; end: (b: string) => void });
  return body;
}

function makeTask(taskId: string, attempts = 0, idempotencyKey?: string): Task {
  return { taskId, sessionId: 's', provider: 'openai', model: 'gpt-4o', scenario: 'bench', config: {}, enqueuedAt: new Date().toISOString(), attempts, idempotencyKey };
}

test('extractCacheMetrics: all zero for empty usage', () => {
  const result = extractCacheMetrics({ prompt: 0, completion: 0 });
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
  assert.equal(result.cacheHitRate, 0);
});

test('extractCacheMetrics: computes hit rate correctly', () => {
  const result = extractCacheMetrics({ prompt: 100, completion: 50, cacheReadTokens: 60, cacheWriteTokens: 10 });
  assert.equal(result.cacheReadTokens, 60);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.cacheHitRate, 0.6);
});

test('extractCacheMetrics: returns 0 hit rate when prompt is 0', () => {
  const result = extractCacheMetrics({ prompt: 0, completion: 50, cacheReadTokens: 100, cacheWriteTokens: 0 });
  assert.equal(result.cacheHitRate, 0);
});

test('extractCacheMetrics: defaults missing cache fields to 0', () => {
  const result = extractCacheMetrics({ prompt: 100, completion: 50 });
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
  assert.equal(result.cacheHitRate, 0);
});

test('metricsHandler: arena_tasks_total reflects taskCounter inc', async () => {
  taskCounter.reset();
  taskCounter.inc({ model: 'gpt-4o', scenario: 'swe-bench', status: 'failed' });
  taskCounter.inc({ model: 'gpt-4o', scenario: 'swe-bench', status: 'completed' });

  const body = await scrapeMetrics();
  assert.match(body, /^arena_tasks_total\{model="gpt-4o",scenario="swe-bench",status="failed"\} 1$/m);
  assert.match(body, /^arena_tasks_total\{model="gpt-4o",scenario="swe-bench",status="completed"\} 1$/m);
});

test('metricsHandler: arena_task_duration_seconds reflects taskDuration observe', async () => {
  taskDuration.reset();
  taskDuration.observe({ model: 'gpt-4o', scenario: 'swe-bench' }, 42.5);

  const body = await scrapeMetrics();
  assert.match(body, /^arena_task_duration_seconds_count\{model="gpt-4o",scenario="swe-bench"\} 1$/m);
  assert.match(body, /^arena_task_duration_seconds_sum\{model="gpt-4o",scenario="swe-bench"\} 42\.5$/m);
});

test('metricsHandler: arena_tasks_active reflects activeTasks gauge', async () => {
  activeTasks.reset();
  activeTasks.inc(2);

  const body = await scrapeMetrics();
  assert.match(body, /^arena_tasks_active 2$/m);
});

test('metricsHandler: arena_queue_depth renders provider label sets', async () => {
  queueDepth.reset();
  queueDepth.set({ provider: 'in-memory' }, 3);
  queueDepth.set({ provider: 'openai' }, 1);

  const body = await scrapeMetrics();
  assert.match(body, /^arena_queue_depth\{provider="in-memory"\} 3$/m);
  assert.match(body, /^arena_queue_depth\{provider="openai"\} 1$/m);
});

test('metricsHandler: arena_schedule_failures_total reflects scheduleFailures inc', async () => {
  scheduleFailures.reset();
  scheduleFailures.inc({ schedule_id: 'sched-nightly' });

  const body = await scrapeMetrics();
  assert.match(body, /^arena_schedule_failures_total\{schedule_id="sched-nightly"\} 1$/m);
});

test('InMemoryQueue wires arena_queue_depth gauge on enqueue/dequeue/ack', async () => {
  queueDepth.reset();

  const q = new InMemoryQueue();
  await q.enqueue(makeTask('a'));
  await q.enqueue(makeTask('b'));
  assert.equal((await scrapeMetrics()).includes('arena_queue_depth{provider="in-memory"} 2'), true);

  const t = await q.dequeue(0);
  assert.ok(t);
  assert.equal((await scrapeMetrics()).includes('arena_queue_depth{provider="in-memory"} 1'), true);

  await q.ack(t!.taskId);
  assert.equal((await scrapeMetrics()).includes('arena_queue_depth{provider="in-memory"} 1'), true);

  await q.enqueue(makeTask('c'));
  const t2 = await q.dequeue(0);
  assert.ok(t2);
  await q.nack(t2!.taskId, 'retry');
  assert.equal((await scrapeMetrics()).includes('arena_queue_depth{provider="in-memory"} 2'), true);
});
