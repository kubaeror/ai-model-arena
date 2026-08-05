import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import { startRunner } from '../../src/runner.js';
import { upsertRun } from '../../src/db/runs.js';
import { ProviderRegistry } from '../../src/providers/index.js';
import type { CreateAdapterOpts } from '../../src/providers/registry.js';
import type { ModelAdapter } from '../../src/providers/adapters/base.js';
import { CircuitBreaker } from '../../src/providers/circuit-breaker.js';
import { tasksFailed, taskCounter } from '../../src/observability/metrics.js';
import type { Task, TaskQueue } from '../../src/queue/types.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': {
      id: 'gpt-4o', name: 'GPT-4o',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10 },
      limit: { context: 128000, output: 16384 },
    },
  } },
};

const ORIG_ENV = { ...process.env };

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function tasksFailedValue(): Promise<number> {
  const snap = await tasksFailed.get();
  return snap.values[0]?.value ?? 0;
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    taskId: 't1',
    sessionId: 's1',
    provider: 'openai',
    model: 'gpt-4o',
    scenario: 'express-rest',
    config: { modelRunId: 'run1', maxTurns: 5 },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    ...overrides,
  } as Task;
}

/**
 * Minimal queue that records nack/ack calls but never redelivers a nacked
 * task. Stands in for InMemoryQueue/RedisStreamQueue redelivery so a test can
 * observe a single sub-threshold failure without the queue retrying it into
 * the DLQ (which is the queue's own, separately-tested behavior).
 */
class NoRetryQueue implements TaskQueue {
  private pending: Task[] = [];
  private inFlight = new Map<string, Task>();
  nacked: Task[] = [];
  acked: string[] = [];

  async enqueue(task: Task): Promise<void> {
    this.pending.push(task);
  }

  async dequeue(_timeoutMs?: number): Promise<Task | null> {
    const t = this.pending.shift() ?? null;
    if (t) this.inFlight.set(t.taskId, t);
    else await new Promise((r) => setTimeout(r, 10));
    return t;
  }

  async ack(taskId: string): Promise<void> {
    this.inFlight.delete(taskId);
    this.acked.push(taskId);
  }

  async nack(taskId: string, _reason?: string): Promise<void> {
    const t = this.inFlight.get(taskId);
    if (t) {
      this.inFlight.delete(taskId);
      this.nacked.push(t);
    }
  }

  async size(): Promise<number> {
    return this.pending.length;
  }

  async deadLetterSize(): Promise<number> {
    return 0;
  }

  async deadLetterPeek(_limit: number): Promise<Task[]> {
    return [];
  }
}

test('runner dequeues and nacks an unresolvable model into the DLQ', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(dbFile);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  tasksFailed.reset();

  // attempts 4 → the nack bumps to 5 and lands in the DLQ.
  await queue.enqueue(makeTask({
    taskId: 'bad-model', sessionId: 'bad-session',
    model: 'nope/nope', provider: 'unknown',
    config: { modelRunId: 'run-bad', maxTurns: 5 },
    attempts: 4,
  }));

  try {
    await waitFor(async () => (await queue.deadLetterSize()) === 1, 8000, 'task in DLQ');
    const dlq = await queue.deadLetterPeek(5);
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0]?.taskId, 'bad-model');
    assert.equal(dlq[0]?.attempts, 5, 'nack should have bumped attempts to the DLQ threshold');
    assert.equal(await tasksFailedValue(), 1, 'dead-lettered model-not-found must count as a terminal failure');
  } finally {
    ac.abort();
    await runnerDone;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner exits promptly when started with an already-aborted signal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(process.env.ARENA_DB_PATH);

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  await startRunner({ queue, signal: ac.signal });
  assert.ok(Date.now() - started < 2000, 'runner should exit without blocking in dequeue');
  await queue.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...ORIG_ENV };
});

test('runner acks a task for a cancelled run without executing it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  delete process.env.OPENAI_API_KEY;
  initDb(process.env.ARENA_DB_PATH);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  await upsertRun({
    runId: 'run3', scenario: 'express-rest', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{ model: 'GPT-4o', runId: 'run3', status: 'running' } as never],
    comparisonMdPath: null, comparisonJsonPath: null,
  });
  const { stopRun } = await import('../../src/orchestrator/run-lifecycle.js');
  await stopRun('run3');

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'cancelled-task', sessionId: 'cancelled-session',
    model: 'GPT-4o', provider: 'openai',
    config: { modelRunId: 'run3', maxTurns: 5 },
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 8000, 'cancelled task acked');
    // Cancelled runs must NOT be finalized as completed — status stays running
    // per-model but the task itself is gone (ack, not execute).
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get('run3', 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'running', 'cancelled run should not transition to completed');
  } finally {
    ac.abort();
    await runnerDone;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner fail-fasts on missing API key: ack + failed state + result.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  delete process.env.OPENAI_API_KEY;
  initDb(dbFile);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  await upsertRun({
    runId: 'run2', scenario: 'express-rest', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{ model: 'GPT-4o', runId: 'run2', status: 'running' } as never],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  tasksFailed.reset();

  await queue.enqueue(makeTask({
    taskId: 'no-key', sessionId: 'no-key-session',
    model: 'GPT-4o', provider: 'openai',
    config: { modelRunId: 'run2', maxTurns: 5 },
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 8000, 'task acked');
    await waitFor(() => {
      const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get('run2', 'GPT-4o') as { status: string } | undefined;
      return row?.status === 'failed';
    }, 5000, 'run_models status failed');

    const resultPath = path.join(outputs, 'GPT-4o', 'run2', 'result.json');
    assert.ok(fs.existsSync(resultPath), 'result.json should exist');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.success, false);
    assert.ok(result.errors[0]?.includes('Missing API key'));
    assert.equal(await tasksFailedValue(), 1, 'missing-key fast-fail (acked, never retried) must count as terminal');
  } finally {
    ac.abort();
    await runnerDone;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner does not count a first-attempt failure below the DLQ threshold as tasksFailed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(dbFile);
  tasksFailed.reset();

  const queue = new NoRetryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  // Scenario load throws before model resolution — lands in the catch block
  // and is nacked. attempts 0 → the nack would requeue, not dead-letter, so
  // it must NOT be counted as a terminal failure.
  await queue.enqueue(makeTask({
    taskId: 'transient', sessionId: 'transient-session',
    scenario: 'no-such-scenario',
    config: { modelRunId: 'run-transient', maxTurns: 5 },
    attempts: 0,
  }));

  try {
    await waitFor(() => queue.nacked.length === 1, 8000, 'task nacked');
    assert.equal(await queue.deadLetterSize(), 0);
    assert.equal(await tasksFailedValue(), 0, 'attempts below the DLQ threshold must not count as terminal');
  } finally {
    ac.abort();
    await runnerDone;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner does not count a requeued model-not-found nack as tasksFailed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  initDb(dbFile);
  tasksFailed.reset();
  taskCounter.reset();

  const queue = new NoRetryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  // Model not found nacks like the catch block: with attempts 0 the nack
  // requeues, so the increment must be gated on the DLQ threshold too.
  await queue.enqueue(makeTask({
    taskId: 'bad-model-transient', sessionId: 'bad-model-transient-session',
    model: 'nope/nope', provider: 'unknown',
    config: { modelRunId: 'run-bad-transient', maxTurns: 5 },
    attempts: 0,
  }));

  try {
    await waitFor(() => queue.nacked.length === 1, 8000, 'task nacked');
    assert.equal(await tasksFailedValue(), 0, 'sub-threshold model-not-found nack must not count as terminal');
    const failed = (await taskCounter.get()).values.filter(
      (m) => m.labels.model === 'nope/nope' && m.labels.status === 'failed',
    );
    assert.equal(failed.length, 0, 'sub-threshold model-not-found must not count taskCounter{status:failed}');
  } finally {
    ac.abort();
    await runnerDone;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

/**
 * Fake adapter: returns a single `task_complete` tool call so the agent loop
 * terminates after turn 1 without touching any real provider. Same shape as
 * the happy-path test's fake — reused here so a fallback attempt completes.
 */
class FakeAdapter implements ModelAdapter {
  calls = 0;

  async sendMessage(): Promise<import('../../src/types.js').ModelResponse> {
    this.calls++;
    return {
      text: 'I verified the work and I am done.',
      toolCalls: [{ id: 'fake-tc-1', name: 'task_complete', arguments: { summary: 'finished by fake adapter' } }],
      usage: { prompt: 12, completion: 6, total: 18 },
      stopReason: 'tool_calls',
    };
  }

  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
}

const FALLBACK_CHAIN = {
  primary: { provider: 'openai', model: 'gpt-4o' },
  fallbacks: [
    { provider: 'anthropic', model: 'claude-sonnet-4' },
    { provider: 'google', model: 'gemini-2.0-flash' },
  ],
};

/**
 * Drive the shared per-provider/model circuit breaker into its OPEN state so
 * the runner's next breaker.exec throws CircuitOpenError immediately — the
 * exact condition the fallback branch handles. Idempotent: re-seeding an
 * already-open breaker is a no-op (exec throws without counting).
 */
async function seedOpenBreaker(provider: string, model: string): Promise<void> {
  const cb = CircuitBreaker.for(provider, model);
  for (let i = 0; i < 6; i++) {
    try { await cb.exec(async () => { throw new Error('seed failure'); }); } catch { /* opening the breaker */ }
  }
}

test('ARENA_MAX_FALLBACK_HOPS=0 stops fallback after the first failure', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fallback0-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ARENA_MAX_FALLBACK_HOPS = '0';
  initDb(dbFile);

  const scenarioPath = path.join(tmp, 'smoke.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: smoke',
    'systemPrompt: You are a test agent.',
    'task: Finish immediately.',
  ].join('\n'));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  await upsertRun({
    runId: 'run-fb0', scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{ model: 'GPT-4o', runId: 'run-fb0', status: 'running' } as never],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  await seedOpenBreaker('openai', 'gpt-4o');

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal, fallbackChain: FALLBACK_CHAIN });

  await queue.enqueue(makeTask({
    taskId: 'fb0', sessionId: 'fb0-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: 'run-fb0', maxTurns: 5 },
    attempts: 4,
  }));

  try {
    await waitFor(async () => (await queue.deadLetterSize()) === 1, 10000, 'task in DLQ');
    assert.equal(await queue.deadLetterSize(), 1, 'hops=0 must fail the task, not requeue');
    assert.equal(fake.calls, 0, 'hops=0 must not consult any fallback adapter');
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
      .get('run-fb0', 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'failed', 'run should be marked failed');
  } finally {
    ac.abort();
    await runnerDone;
    ProviderRegistry.prototype.createAdapter = origCreateAdapter;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('ARENA_MAX_FALLBACK_HOPS=3 falls back through the chain when the primary circuit is open', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fallback3-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ARENA_MAX_FALLBACK_HOPS = '3';
  initDb(dbFile);

  const scenarioPath = path.join(tmp, 'smoke.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: smoke',
    'systemPrompt: You are a test agent.',
    'task: Finish immediately.',
  ].join('\n'));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  await upsertRun({
    runId: 'run-fb3', scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{ model: 'GPT-4o', runId: 'run-fb3', status: 'running' } as never],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  await seedOpenBreaker('openai', 'gpt-4o');

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal, fallbackChain: FALLBACK_CHAIN });

  await queue.enqueue(makeTask({
    taskId: 'fb3', sessionId: 'fb3-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: 'run-fb3', maxTurns: 5 },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    assert.equal(await queue.deadLetterSize(), 0, 'fallback run must ack, not nack');
    assert.equal(fake.calls, 1, 'the fallback provider should have been consulted exactly once');
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
      .get('run-fb3', 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'completed', 'run should complete via the fallback provider');
    const resultPath = path.join(outputs, 'GPT-4o', 'run-fb3', 'result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { success: boolean };
    assert.equal(result.success, true);
  } finally {
    ac.abort();
    await runnerDone;
    ProviderRegistry.prototype.createAdapter = origCreateAdapter;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});
