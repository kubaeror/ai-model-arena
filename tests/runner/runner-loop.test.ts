import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { modelDirSegment } from '../../src/paths.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import { startRunner } from '../../src/runner.js';
import { upsertRun } from '../../src/db/runs.js';
import { ProviderRegistry } from '../../src/providers/index.js';
import type { CreateAdapterOpts } from '../../src/providers/registry.js';
import type { ModelAdapter, SendOpts } from '../../src/providers/adapters/base.js';
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
    'o3': {
      id: 'o3', name: 'o3',
      attachment: false, reasoning: true, temperature: false, tool_call: true,
      cost: { input: 2, output: 8 },
      limit: { context: 200000, output: 100000 },
    },
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
    'claude-3-7-sonnet': {
      id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet',
      attachment: true, reasoning: true, temperature: true, tool_call: true,
      cost: { input: 3, output: 15 },
      limit: { context: 200000, output: 8192 },
    },
    'claude-3.7': {
      id: 'claude-3.7', name: 'claude-3.7',
      attachment: false, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 3, output: 15 },
      limit: { context: 200000, output: 8192 },
    },
    'claude-sonnet-4': {
      id: 'claude-sonnet-4', name: 'Claude Sonnet 4',
      attachment: true, reasoning: true, temperature: true, tool_call: true,
      cost: { input: 3, output: 15 },
      limit: { context: 200000, output: 8192 },
    },
  } },
  'amazon-bedrock': { id: 'amazon-bedrock', name: 'Amazon Bedrock', env: ['AWS_BEDROCK_REGION'], models: {
    'anthropic.claude-3-sonnet-20240229-v1:0': {
      id: 'anthropic.claude-3-sonnet-20240229-v1:0', name: 'Claude 3 Sonnet (Bedrock)',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 3, output: 15 },
      limit: { context: 200000, output: 4096 },
    },
  } },
};

// modelDirSegment('openai/gpt-4o') — the runner derives the model directory
// from the resolved canonical id, not the display name.
const MODEL_DIR = 'openai_gpt-4o';

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
  protected pending: Task[] = [];
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

  async pendingCount(): Promise<number> {
    return this.pending.length;
  }

  async deadLetterRetry(_taskId: string): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    // no-op — in-memory state is lost on process exit
  }
}

/**
 * Same double as NoRetryQueue, but exposes an explicit `requeue` so a test can
 * redeliver a nacked task with the attempt bump a real queue's retry applies.
 */
class RetryOnDemandQueue extends NoRetryQueue {
  requeue(taskId: string): void {
    const task = this.nacked.find((t) => t.taskId === taskId);
    if (!task) throw new Error(`task was not nacked: ${taskId}`);
    task.attempts += 1;
    this.pending.push(task);
  }
}

/** Same double as NoRetryQueue, but ack always fails after the loop finishes. */
class AckFailingQueue extends NoRetryQueue {
  override async ack(_taskId: string): Promise<void> {
    throw new Error('simulated ack failure');
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

  await upsertRun({
    runId: 'run-bad', scenario: 'express-rest', models: ['nope/nope'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{ model: 'nope/nope', runId: 'run-bad', status: 'running' } as never],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

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
    // The dead-lettered model task is terminal: the model row must reach a
    // non-running status and the run must self-finalize (no dashboard watcher
    // in this process) instead of staying wedged in 'running' forever.
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get('run-bad', 'nope/nope') as { status: string } | undefined;
    assert.notEqual(row?.status, 'running', 'dead-lettered model-not-found must not stay running');
    const { getRunRecord } = await import('../../src/db/runs.js');
    await waitFor(async () => (await getRunRecord('run-bad'))?.status === 'completed', 5000, 'run self-finalized');
    const rec = await getRunRecord('run-bad');
    assert.equal(rec?.status, 'completed', 'dead-lettered run must be finalized by the runner');
    assert.notEqual(rec?.perModel[0]?.status, 'running', 'indexed model row must not stay running');
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
  const { stopRun, isRunCancelled } = await import('../../src/orchestrator/run-lifecycle.js');
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
    // Cancelled runs must NOT be finalized as completed — the ack path never
    // executes the task. The runner's pre-execution cancel check marks the
    // per-model row 'stopped' (terminal), so it must not stay 'running'.
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get('run3', 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'stopped', 'cancelled run per-model row should be terminal (stopped)');
    const runRow = getDb().prepare('SELECT status FROM runs WHERE run_id = ?').get('run3') as { status: string } | undefined;
    assert.equal(runRow?.status, 'stopped', 'cancelled run must not be finalized as completed');
    assert.equal(await isRunCancelled('run3'), false, 'the runner must clear the cancel signal after acknowledging the stop');
  } finally {
    ac.abort();
    await runnerDone;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner keeps a mid-execution stopRun stopped: halts the loop and never completes', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-midstop-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
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

  const runId = 'run-midstop';
  const modelRunDir = path.join(outputs, MODEL_DIR, runId);
  await upsertRun({
    runId, scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: 'GPT-4o', runId, status: 'running',
      outputDir: modelRunDir,
      sandboxDir: path.join(modelRunDir, 'files'),
      resultPath: path.join(modelRunDir, 'result.json'),
      conversationPath: path.join(modelRunDir, 'conversation.json'),
      reportPath: path.join(modelRunDir, 'report.md'),
      logFile: path.join(modelRunDir, 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const { stopRun, isRunCancelled } = await import('../../src/orchestrator/run-lifecycle.js');
  /** Stops the run from inside the first model send, then returns a tool call
   *  so the loop attempts a second turn — where onBudgetCheck sees the cancel. */
  class StoppingAdapter implements ModelAdapter {
    calls = 0;
    async sendMessage(): Promise<import('../../src/types.js').ModelResponse> {
      this.calls++;
      await stopRun(runId);
      return {
        text: 'Stop requested mid-turn.',
        toolCalls: [{ id: 'stop-tc-1', name: 'list_files', arguments: { path: '.' } }],
        usage: { prompt: 5, completion: 2, total: 7 },
        stopReason: 'tool_calls',
      };
    }
    supportsReasoning(): boolean { return false; }
    supportsPromptCaching(): boolean { return false; }
  }
  const fake = new StoppingAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'midstop-task', sessionId: 'midstop-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'stopped task acked');
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
      .get(runId, 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'stopped', 'mid-execution stop must leave run_models stopped');
    const runRow = getDb().prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as { status: string } | undefined;
    assert.equal(runRow?.status, 'stopped', 'mid-execution stop must not be finalized to completed');
    assert.equal(fake.calls, 1, 'the cancellation check must halt the loop after the stopping turn');
    const session = getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('midstop-session') as { status: string } | undefined;
    assert.equal(session?.status, 'active', 'a stopped run must not mark its session completed');
    assert.equal(await queue.deadLetterSize(), 0, 'stopped task must be acked, not nacked');
    assert.ok(fs.existsSync(path.join(modelRunDir, 'result.json')), 'terminal artifacts must be written before the ack');
    assert.equal(await isRunCancelled(runId), false, 'the runner must clear the cancel signal after writing terminal stopped artifacts');
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

test('runner keeps the stop gate closed when a per-model failure is retryable', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stop-retry-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
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

  const runId = 'run-stop-retry';
  const alphaModel = 'GPT-4o';
  const betaModel = 'claude-3.7';
  const dirs = new Map<string, string>([
    [alphaModel, path.join(outputs, MODEL_DIR, runId)],
    [betaModel, path.join(outputs, modelDirSegment('anthropic/claude-3.7'), runId)],
  ]);
  await upsertRun({
    runId, scenario: 'smoke', models: [alphaModel, betaModel],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [...dirs].map(([model, dir]) => ({
      model, runId, status: 'running',
      outputDir: dir, sandboxDir: path.join(dir, 'files'),
      resultPath: path.join(dir, 'result.json'),
      conversationPath: path.join(dir, 'conversation.json'),
      reportPath: path.join(dir, 'report.md'), logFile: path.join(dir, 'runner.log'),
    })) as never,
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const { stopRun, isRunCancelled, prepareRunFinalization } = await import('../../src/orchestrator/run-lifecycle.js');
  const { markRunCancelled } = await import('../../src/orchestrator/run-signals.js');
  const { getRunRecord } = await import('../../src/db/runs.js');

  class CompleteAdapter implements ModelAdapter {
    async sendMessage(): Promise<import('../../src/types.js').ModelResponse> {
      return {
        text: 'done',
        toolCalls: [{ id: 'alpha-tc', name: 'task_complete', arguments: { summary: 'done' } }],
        usage: { prompt: 2, completion: 1, total: 3 },
        stopReason: 'tool_calls',
      };
    }
    supportsReasoning(): boolean { return false; }
    supportsPromptCaching(): boolean { return false; }
  }
  const alphaFake = new CompleteAdapter();
  let betaAdapterRequests = 0;

  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    if (modelId === 'claude-3.7') {
      betaAdapterRequests++;
      // Arm the stop synchronously (in-memory signal store), then fail the
      // attempt the way a provider construction error would.
      void markRunCancelled(runId);
      void stopRun(runId).catch(() => undefined);
      throw new Error('transient adapter failure');
    }
    return alphaFake;
  };

  const queue = new RetryOnDemandQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'alpha-task', sessionId: 'alpha-session',
    model: alphaModel, provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(() => {
      const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get(runId, alphaModel) as { status: string } | undefined;
      return row?.status === 'completed';
    }, 10000, 'alpha completes');

    await queue.enqueue(makeTask({
      taskId: 'beta-task', sessionId: 'beta-session',
      model: betaModel, provider: 'anthropic', scenario: scenarioPath,
      config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
      attempts: 0,
    }));

    await waitFor(() => queue.nacked.length === 1, 10000, 'beta retryable nack');
    const betaRow = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get(runId, betaModel) as { status: string } | undefined;
    assert.equal(betaRow?.status, 'failed', 'a retryable failure keeps the failed row');
    assert.equal(betaAdapterRequests, 1, 'beta attempt ran once');
    assert.equal(await isRunCancelled(runId), true, 'a retryable failure must not clear the stop signal');

    await waitFor(async () => (await getRunRecord(runId))?.status === 'stopped', 5000, 'stopRun marks the run stopped');
    assert.equal(await prepareRunFinalization(runId), false, 'the pending retry must keep the run unfinalizable');
    assert.notEqual((await getRunRecord(runId))?.status, 'completed', 'the run must not finalize while the retry is pending');

    // Redeliver the retry: under the stop gate it must be acked before
    // execution, so the adapter is never built again and no second nack lands.
    queue.requeue('beta-task');
    await waitFor(() => queue.acked.includes('beta-task') || betaAdapterRequests > 1, 10000, 'retry resolved');
    assert.equal(betaAdapterRequests, 1, 'the retry must not execute after the stop');
    assert.equal(queue.nacked.length, 1, 'the retry must be acked, not nacked');
    assert.equal(await isRunCancelled(runId), false, 'acking the retry clears the signal');
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

test('runner terminalizes a failed attempt under an active stop as stopped', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-stop-terminal-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
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

  const runId = 'run-stop-terminal';
  const alphaModel = 'GPT-4o';
  const betaModel = 'claude-3.7';
  // Alpha stays non-terminal: it keeps the stop signal set after beta's
  // terminal failure, so the stopped row stays observable (no finalize rewrite).
  await upsertRun({
    runId, scenario: 'smoke', models: [alphaModel, betaModel],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [
      { model: alphaModel, runId, status: 'running' },
      { model: betaModel, runId, status: 'running' },
    ] as never,
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const { stopRun, isRunCancelled, prepareRunFinalization } = await import('../../src/orchestrator/run-lifecycle.js');
  const { markRunCancelled } = await import('../../src/orchestrator/run-signals.js');
  const { getRunRecord } = await import('../../src/db/runs.js');

  let betaAdapterRequests = 0;
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    if (modelId === 'claude-3.7') {
      betaAdapterRequests++;
      void markRunCancelled(runId);
      void stopRun(runId).catch(() => undefined);
      throw new Error('terminal adapter failure');
    }
    throw new Error(`unexpected adapter request for ${modelId}`);
  };

  const queue = new RetryOnDemandQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  // attempts 4: the nack is terminal (dead-letter), mirroring an exhausted retry budget.
  await queue.enqueue(makeTask({
    taskId: 'beta-task', sessionId: 'beta-session',
    model: betaModel, provider: 'anthropic', scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 4,
  }));

  try {
    await waitFor(() => queue.nacked.length === 1, 10000, 'terminal beta nack');
    const betaRow = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?').get(runId, betaModel) as { status: string } | undefined;
    assert.equal(betaRow?.status, 'stopped', 'a terminal failure under an active stop is a stop ack');
    assert.equal(betaAdapterRequests, 1, 'the terminal attempt ran once and dead-lettered');
    assert.equal(await isRunCancelled(runId), true, 'the sibling model is still running so the signal stays set');

    await waitFor(async () => (await getRunRecord(runId))?.status === 'stopped', 5000, 'stopRun marks the run stopped');
    assert.equal(await prepareRunFinalization(runId), false, 'the non-terminal sibling must keep the run unfinalizable');
    assert.notEqual((await getRunRecord(runId))?.status, 'completed', 'the run must not finalize with a sibling still running');
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

test('runner does not nack a finished session when queue.ack throws', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ackfail-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
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

  const runId = 'run-ack-fail';
  const modelRunDir = path.join(outputs, MODEL_DIR, runId);
  await upsertRun({
    runId, scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: 'GPT-4o', runId, status: 'running',
      outputDir: modelRunDir,
      sandboxDir: path.join(modelRunDir, 'files'),
      resultPath: path.join(modelRunDir, 'result.json'),
      conversationPath: path.join(modelRunDir, 'conversation.json'),
      reportPath: path.join(modelRunDir, 'report.md'),
      logFile: path.join(modelRunDir, 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new AckFailingQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'ack-fail-task', sessionId: 'ack-fail-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(() => {
      const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
        .get(runId, 'GPT-4o') as { status: string } | undefined;
      return row?.status === 'completed';
    }, 10000, 'run_models completed despite ack failure');
    assert.equal(queue.nacked.length, 0, 'a finished session must never be nacked');
    const { getRunRecord } = await import('../../src/db/runs.js');
    await waitFor(async () => (await getRunRecord(runId))?.status === 'completed', 10000, 'run self-finalized despite ack failure');
    const session = getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('ack-fail-session') as { status: string } | undefined;
    assert.equal(session?.status, 'completed', 'session bookkeeping must still run before ack');
    assert.equal(await queue.deadLetterSize(), 0, 'ack failure must not dead-letter a finished session');
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
    // Fail-fast must self-finalize like every other terminal path — it must
    // not depend on the dashboard watcher being up. (The transient 'failed'
    // transition is rewritten by patchIndexAfterFinalize, so assert the
    // post-finalize states.)
    const { getRunRecord } = await import('../../src/db/runs.js');
    await waitFor(async () => (await getRunRecord('run2'))?.status === 'completed', 5000, 'fail-fast run self-finalized');
    const rec = await getRunRecord('run2');
    assert.equal(rec?.status, 'completed', 'missing-api-key run must be finalized by the runner');
    assert.notEqual(rec?.perModel[0]?.status, 'running', 'per-model row must not stay running');

    const resultPath = path.join(outputs, MODEL_DIR, 'run2', 'result.json');
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

test('runner does not require an API-key secret for Bedrock models (IAM auth)', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bedrock-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  delete process.env.AWS_BEDROCK_REGION;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
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

  const modelId = 'amazon-bedrock/anthropic.claude-3-sonnet-20240229-v1:0';
  const runId = 'run-bedrock';
  const modelRunDir = path.join(outputs, modelDirSegment(modelId), runId);
  await upsertRun({
    runId, scenario: 'smoke', models: [modelId],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: modelId, runId, status: 'running',
      outputDir: modelRunDir,
      sandboxDir: path.join(modelRunDir, 'files'),
      resultPath: path.join(modelRunDir, 'result.json'),
      conversationPath: path.join(modelRunDir, 'conversation.json'),
      reportPath: path.join(modelRunDir, 'report.md'),
      logFile: path.join(modelRunDir, 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'bedrock-task', sessionId: 'bedrock-session',
    provider: 'amazon-bedrock', model: modelId, scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'bedrock task acked');

    // Bedrock's catalog envVar is the region and the SDK uses IAM credentials:
    // an unset AWS_BEDROCK_REGION must not trigger the missing-API-key path.
    assert.equal(fake.calls, 1, 'bedrock task must execute instead of failing the key check');
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
      .get(runId, modelId) as { status: string } | undefined;
    assert.equal(row?.status, 'completed', 'bedrock run should complete');

    const resultPath = path.join(modelRunDir, 'result.json');
    assert.ok(fs.existsSync(resultPath), 'result.json should exist');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { success: boolean; errors: string[] };
    assert.equal(result.success, true);
    assert.ok(
      !result.errors.some((e) => e.includes('Missing API key')),
      'bedrock must not be treated as API-key auth',
    );
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
  lastOpts: SendOpts | undefined;

  async sendMessage(_messages: import('../../src/types.js').ChatMessage[], _tools: import('../../src/types.js').ToolDefinition[], opts?: SendOpts): Promise<import('../../src/types.js').ModelResponse> {
    this.calls++;
    this.lastOpts = opts;
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
    perModel: [{
      model: 'GPT-4o', runId: 'run-fb0', status: 'running',
      outputDir: path.join(outputs, MODEL_DIR, 'run-fb0'),
      sandboxDir: path.join(outputs, MODEL_DIR, 'run-fb0', 'files'),
      resultPath: path.join(outputs, MODEL_DIR, 'run-fb0', 'result.json'),
      conversationPath: path.join(outputs, MODEL_DIR, 'run-fb0', 'conversation.json'),
      reportPath: path.join(outputs, MODEL_DIR, 'run-fb0', 'report.md'),
      logFile: path.join(outputs, MODEL_DIR, 'run-fb0', 'runner.log'),
    }],
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
    config: { modelRunId: 'run-fb0', maxTurns: 5, scenarioSource: 'cli' },
    attempts: 4,
  }));

  try {
    await waitFor(async () => (await queue.deadLetterSize()) === 1, 10000, 'task in DLQ');
    assert.equal(await queue.deadLetterSize(), 1, 'hops=0 must fail the task, not requeue');
    assert.equal(fake.calls, 0, 'hops=0 must not consult any fallback adapter');
    // The runner self-finalizes the terminal-failed run (no dashboard watcher
    // here): the index run record becomes 'completed', and finalizeRunByRunId
    // writes back per-model entries from its aggregation. A dead-lettered task
    // produced no result.json, so the per-model row is indexed 'errored'
    // (established finalize semantics — see orchestrator/finalize-merge),
    // replacing the transient 'failed' transition.
    const { getRunRecord } = await import('../../src/db/runs.js');
    await waitFor(async () => {
      const rec = await getRunRecord('run-fb0');
      return rec?.status === 'completed' && rec.perModel[0]?.status === 'errored';
    }, 5000, 'terminal-failed run self-finalized');
    const rec = await getRunRecord('run-fb0');
    assert.equal(rec?.status, 'completed', 'terminal-failed run must be finalized by the runner');
    assert.equal(rec?.perModel[0]?.status, 'errored', 'dead-lettered model (no result.json) indexed errored');
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

test('runner rejects a traversal modelRunId before creating output directories', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-traversal-'));
  const outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  initDb(process.env.ARENA_DB_PATH);

  const queue = new NoRetryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'traversal-runid', sessionId: 'traversal-runid-session',
    model: 'GPT-4o', provider: 'openai',
    config: { modelRunId: '../../escaped', maxTurns: 5 },
    attempts: 0,
  }));

  try {
    await waitFor(() => queue.nacked.length === 1, 8000, 'task nacked');
    assert.equal(queue.nacked[0]?.taskId, 'traversal-runid');
    assert.ok(
      !fs.existsSync(path.resolve(outputs, '..', 'escaped')),
      'a traversal modelRunId must not create directories outside outputRoot()',
    );
    assert.ok(!fs.existsSync(path.join(outputs, MODEL_DIR)), 'no model output dir may be created');
  } finally {
    ac.abort();
    await runnerDone;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner rejects an explicit scenario path unless the task is CLI-sourced', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-scenario-path-'));
  const outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  delete process.env.OPENAI_API_KEY;
  initDb(process.env.ARENA_DB_PATH);

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

  const queue = new NoRetryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'dashboard-path', sessionId: 'dashboard-path-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: 'run-dashboard-path', maxTurns: 5 },
    attempts: 0,
  }));

  try {
    await waitFor(() => queue.nacked.length === 1, 8000, 'task nacked');
    assert.equal(queue.nacked[0]?.taskId, 'dashboard-path');
    assert.ok(!fs.existsSync(path.join(outputs, MODEL_DIR)), 'no output dir for a rejected scenario path');
  } finally {
    ac.abort();
    await runnerDone;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner accepts display, dotted, and canonical lookup keys and derives contained dirs', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-lookup-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
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

  // openai/gpt-4o is used by the fallback tests above, which deliberately
  // leave that breaker open; exercise the slash path with an anthropic
  // canonical id whose breaker is untouched.
  const cases = [
    { lookup: 'Claude 3.7 Sonnet', provider: 'anthropic', runId: 'run-display-name', dir: 'anthropic_claude-3-7-sonnet' },
    { lookup: 'claude-3.7', provider: 'anthropic', runId: 'run-dotted-name', dir: 'anthropic_claude-3.7' },
    { lookup: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', runId: 'run-canonical-id', dir: 'anthropic_claude-3-7-sonnet' },
  ];

  for (const c of cases) {
    const modelRunDir = path.join(outputs, c.dir, c.runId);
    await upsertRun({
      runId: c.runId, scenario: 'smoke', models: [c.lookup],
      startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
      perModel: [{
        model: c.lookup, runId: c.runId, status: 'running',
        outputDir: modelRunDir,
        sandboxDir: path.join(modelRunDir, 'files'),
        resultPath: path.join(modelRunDir, 'result.json'),
        conversationPath: path.join(modelRunDir, 'conversation.json'),
        reportPath: path.join(modelRunDir, 'report.md'),
        logFile: path.join(modelRunDir, 'runner.log'),
      }],
      comparisonMdPath: null, comparisonJsonPath: null,
    });
  }

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  for (const c of cases) {
    await queue.enqueue(makeTask({
      taskId: `lookup-${c.runId}`, sessionId: `lookup-${c.runId}-session`,
      model: c.lookup, provider: c.provider, scenario: scenarioPath,
      config: { modelRunId: c.runId, maxTurns: 5, scenarioSource: 'cli' },
      attempts: 0,
    }));
  }

  try {
    await waitFor(async () => (await queue.size()) === 0, 15000, 'lookup-key tasks acked');
    assert.equal(await queue.deadLetterSize(), 0, 'valid lookup keys must ack, not nack');
    assert.equal(fake.calls, cases.length, 'each lookup key must execute exactly one turn');

    for (const c of cases) {
      const resultPath = path.join(outputs, c.dir, c.runId, 'result.json');
      assert.ok(fs.existsSync(resultPath), `result.json for "${c.lookup}" must exist at ${resultPath}`);
      assert.ok(
        !fs.existsSync(path.resolve(outputs, '..', c.dir)),
        `"${c.lookup}" must not create directories outside outputRoot()`,
      );
    }
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
    perModel: [{
      model: 'GPT-4o', runId: 'run-fb3', status: 'running',
      outputDir: path.join(outputs, MODEL_DIR, 'run-fb3'),
      sandboxDir: path.join(outputs, MODEL_DIR, 'run-fb3', 'files'),
      resultPath: path.join(outputs, MODEL_DIR, 'run-fb3', 'result.json'),
      conversationPath: path.join(outputs, MODEL_DIR, 'run-fb3', 'conversation.json'),
      reportPath: path.join(outputs, MODEL_DIR, 'run-fb3', 'report.md'),
      logFile: path.join(outputs, MODEL_DIR, 'run-fb3', 'runner.log'),
    }],
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
    config: { modelRunId: 'run-fb3', maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    assert.equal(await queue.deadLetterSize(), 0, 'fallback run must ack, not nack');
    assert.equal(fake.calls, 1, 'the fallback provider should have been consulted exactly once');
    const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
      .get('run-fb3', 'GPT-4o') as { status: string } | undefined;
    assert.equal(row?.status, 'completed', 'run should complete via the fallback provider');
    const resultPath = path.join(outputs, MODEL_DIR, 'run-fb3', 'result.json');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as { success: boolean; costUsd: number };
    assert.equal(result.success, true);
    // claude-sonnet-4 (fallback) is input 3 / output 15: 12*3/1e6 + 6*15/1e6
    // = 0.000126. Billing at the primary gpt-4o rates (2.5/10) would be 0.00009.
    assert.ok(
      Math.abs(result.costUsd - 0.000126) < 1e-12,
      `fallback calls must be billed at the serving model's rates, got ${result.costUsd}`,
    );
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

test('fallback hop receives its own send options, not the primary model’s', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fallback-opts-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
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
    runId: 'run-fb-opts', scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: 'GPT-4o', runId: 'run-fb-opts', status: 'running',
      outputDir: path.join(outputs, MODEL_DIR, 'run-fb-opts'),
      sandboxDir: path.join(outputs, MODEL_DIR, 'run-fb-opts', 'files'),
      resultPath: path.join(outputs, MODEL_DIR, 'run-fb-opts', 'result.json'),
      conversationPath: path.join(outputs, MODEL_DIR, 'run-fb-opts', 'conversation.json'),
      reportPath: path.join(outputs, MODEL_DIR, 'run-fb-opts', 'report.md'),
      logFile: path.join(outputs, MODEL_DIR, 'run-fb-opts', 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const created: FakeAdapter[] = [];
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    const fake = new FakeAdapter();
    created.push(fake);
    return fake;
  };

  await seedOpenBreaker('openai', 'gpt-4o');

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal, fallbackChain: FALLBACK_CHAIN });

  await queue.enqueue(makeTask({
    taskId: 'fb-opts', sessionId: 'fb-opts-session',
    model: 'GPT-4o', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: 'run-fb-opts', maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    assert.equal(await queue.deadLetterSize(), 0, 'fallback run must ack, not nack');
    assert.equal(created.length, 2, 'one primary adapter plus one fallback adapter');
    assert.equal(created[0]!.calls, 0, 'the open primary circuit must skip the primary adapter');
    assert.equal(created[1]!.calls, 1, 'the fallback adapter should run the loop');
    // gpt-4o (primary) has output 16384; claude-sonnet-4 (fallback) has 8192.
    // The hop must use its own catalog values, not the primary's.
    assert.deepEqual(created[1]!.lastOpts, { temperature: 0.2, maxTokens: 8192 },
      'fallback hop must receive its own temperature/maxTokens');
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

test('reasoning-only models do not receive unsupported temperature or max_tokens', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-reasoning-only-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
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

  const runId = 'run-reasoning-only';
  const dir = modelDirSegment('openai/o3');
  const modelRunDir = path.join(outputs, dir, runId);
  await upsertRun({
    runId, scenario: 'smoke', models: ['o3'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: 'o3', runId, status: 'running',
      outputDir: modelRunDir,
      sandboxDir: path.join(modelRunDir, 'files'),
      resultPath: path.join(modelRunDir, 'result.json'),
      conversationPath: path.join(modelRunDir, 'conversation.json'),
      reportPath: path.join(modelRunDir, 'report.md'),
      logFile: path.join(modelRunDir, 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  await queue.enqueue(makeTask({
    taskId: 'reasoning-only-task', sessionId: 'reasoning-only-session',
    model: 'o3', provider: 'openai', scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    attempts: 0,
  }));

  try {
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    assert.equal(fake.calls, 1, 'reasoning-only task should execute exactly one turn');
    assert.ok(fake.lastOpts, 'adapter must receive send options');
    // o3 rejects temperature and max_tokens (it needs max_completion_tokens):
    // both must be omitted rather than inherited from defaults.
    assert.ok(!('temperature' in fake.lastOpts), 'reasoning-only model must not receive temperature');
    assert.ok(!('maxTokens' in fake.lastOpts), 'reasoning-only model must not receive max tokens');
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

