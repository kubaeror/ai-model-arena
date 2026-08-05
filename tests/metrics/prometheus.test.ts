import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheMetrics } from '../../src/metrics/cache-metrics.js';
import {
  taskCounter,
  taskDuration,
  activeTasks,
  queueDepth,
  scheduleFailures,
  dlqDepth,
  circuitState,
  budgetPercent,
  apiErrors,
  tasksClaimed,
  tasksFailed,
  providerLatency,
  metricsHandler,
} from '../../src/observability/metrics.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';
import { CircuitBreaker } from '../../src/providers/circuit-breaker.js';
import { BaseAdapter, HttpError } from '../../src/providers/adapters/base.js';
import { loadBudgetConfig, checkBudget, resetBudgetCache } from '../../src/cost-tracking/budget.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('metricsHandler: arena_dlq_depth reflects DLQ pushes in InMemoryQueue', async () => {
  dlqDepth.reset();
  const q = new InMemoryQueue();
  // attempts 4 → nack bumps to 5 → dead-lettered
  await q.enqueue(makeTask('dlq1', 4));
  const claimed = await q.dequeue(0);
  assert.ok(claimed);
  await q.nack(claimed.taskId, 'boom');
  assert.equal((await q.deadLetterSize()), 1);

  const body = await scrapeMetrics();
  assert.match(body, /^arena_dlq_depth\{provider="in-memory"\} 1$/m);
});

test('metricsHandler: arena_circuit_state reflects open/close via CircuitBreaker.for', async () => {
  circuitState.reset();
  const cb = CircuitBreaker.for('openai', 'gpt-4o', { failureThreshold: 1, resetTimeoutMs: 50 });
  try {
    await assert.rejects(() => cb.exec(async () => { throw new Error('boom'); }));
    assert.match(await scrapeMetrics(), /^arena_circuit_state\{provider="openai",model="gpt-4o"\} 1$/m);

    await new Promise((r) => setTimeout(r, 70));
    const res = await cb.exec(async () => 'ok');
    assert.equal(res, 'ok');
    assert.equal(cb.state, 'closed');
    assert.match(await scrapeMetrics(), /^arena_circuit_state\{provider="openai",model="gpt-4o"\} 0$/m);
  } finally {
    CircuitBreaker.cleanup();
  }
});

test('metricsHandler: arena_budget_percent reflects percentUsed from checkBudget', async () => {
  budgetPercent.reset();
  resetBudgetCache();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-metrics-budget-'));
  try {
    const rootDir = path.join(tmp, 'run');
    fs.mkdirSync(path.join(rootDir, 'outputs'), { recursive: true });
    const configPath = path.join(tmp, 'config.yaml');
    fs.writeFileSync(configPath, 'global:\n  daily: 10\nstateFile: outputs/.budget-state.json\n');
    const dayKey = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(rootDir, 'outputs', '.budget-state.json'), JSON.stringify({
      global: { daily: {}, monthly: {} },
      models: { 'gpt-4o': { daily: { [dayKey]: 15 }, monthly: {} } },
      lastReset: new Date().toISOString(),
    }));
    loadBudgetConfig(configPath);
    const result = checkBudget('gpt-4o', rootDir);
    assert.equal(result.percentUsed, 150);

    const body = await scrapeMetrics();
    assert.match(body, /^arena_budget_percent\{model="gpt-4o"\} 150$/m);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

class TestAdapter extends BaseAdapter {
  constructor(provider: string) {
    super();
    this.providerLabel = provider;
  }
  async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return this.withRetry(fn, { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 });
  }
  async measure<T>(fn: () => Promise<T>): Promise<T & { durationMs: number }> {
    return this.timed(fn);
  }
}

test('metricsHandler: arena_api_errors_total increments on terminal HTTP error in BaseAdapter', async () => {
  apiErrors.reset();
  const adapter = new TestAdapter('openai');
  await assert.rejects(
    () => adapter.runWithRetry(async () => { throw new HttpError(429, 'rate limited', 'rate limited'); }),
    HttpError,
  );
  assert.match(await scrapeMetrics(), /^arena_api_errors_total\{provider="openai"\} 1$/m);
});

test('metricsHandler: arena_provider_latency_seconds observes send latency in BaseAdapter', async () => {
  providerLatency.reset();
  const adapter = new TestAdapter('anthropic');
  await adapter.measure(async () => { await new Promise((r) => setTimeout(r, 20)); return { text: 'ok' }; });

  const body = await scrapeMetrics();
  assert.match(body, /^arena_provider_latency_seconds_count\{provider="anthropic"\} 1$/m);
  assert.match(body, /^arena_provider_latency_seconds_sum\{provider="anthropic"\} (0\.0[1-9]|[1-9])/m);
});

test('metricsHandler: arena_tasks_claimed_total / arena_tasks_failed_total reflect runner counters', async () => {
  tasksClaimed.reset();
  tasksFailed.reset();
  tasksClaimed.inc();
  tasksClaimed.inc();
  tasksFailed.inc();

  const body = await scrapeMetrics();
  assert.match(body, /^arena_tasks_claimed_total 2$/m);
  assert.match(body, /^arena_tasks_failed_total 1$/m);
});
