import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';
import { startRunner } from '../../src/runner.js';
import { evaluateRunLimits, resolveExecutionStartMs } from '../../src/runner/limits.js';
import { upsertRun } from '../../src/db/runs.js';
import { ProviderRegistry } from '../../src/providers/index.js';
import type { ModelAdapter } from '../../src/providers/adapters/base.js';
import type { ChatMessage, ModelResponse, ToolDefinition } from '../../src/types.js';

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

const MODEL_DIR = 'openai_gpt-4o';
const ORIG_ENV = { ...process.env };

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface Harness { tmp: string; outputs: string }

function setupEnvironment(prefix: string): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
  process.env.OTEL_ENABLED = 'false';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  initDb(process.env.ARENA_DB_PATH);
  return { tmp, outputs };
}

async function syncCatalog(): Promise<void> {
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
}

async function registerRun(runId: string, outputs: string, startedAt = new Date().toISOString()): Promise<void> {
  const modelRunDir = path.join(outputs, MODEL_DIR, runId);
  await upsertRun({
    runId, scenario: 'smoke', models: ['GPT-4o'],
    startedAt, finishedAt: null, status: 'running', source: 'cli',
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
}

function stubAdapter(fake: ModelAdapter): () => void {
  const orig = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (): ModelAdapter { return fake; };
  return () => { ProviderRegistry.prototype.createAdapter = orig; };
}

/** Keeps requesting a read-only tool so only a run limit can stop the loop. */
class LoopingAdapter implements ModelAdapter {
  calls = 0;
  onCall: (() => void) | undefined;
  constructor(private usage: { prompt: number; completion: number } = { prompt: 5, completion: 2 }) {}

  async sendMessage(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelResponse> {
    this.calls++;
    this.onCall?.();
    return {
      text: 'still working',
      toolCalls: [{ id: `loop-tc-${this.calls}`, name: 'list_files', arguments: { path: '.' } }],
      usage: { ...this.usage },
      stopReason: 'tool_calls',
    };
  }

  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
}

function teardown(ac: AbortController, runnerDone: Promise<void>, restore: () => void, queue: InMemoryQueue, tmp: string): Promise<void> {
  ac.abort();
  return runnerDone.then(async () => {
    restore();
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  });
}

test('evaluateRunLimits stays silent within both limits', () => {
  assert.equal(evaluateRunLimits(
    { maxExecutionSec: 600, maxCostUsd: 5 },
    { elapsedMs: 599_000, runCostUsd: 4.99 },
  ), null);
});

test('evaluateRunLimits flags a wall-clock breach with a distinct reason', () => {
  assert.equal(evaluateRunLimits(
    { maxExecutionSec: 600, maxCostUsd: 5 },
    { elapsedMs: 600_001, runCostUsd: 0 },
  ), 'max_execution_time_exceeded');
});

test('evaluateRunLimits flags a per-run cost breach with a distinct reason', () => {
  assert.equal(evaluateRunLimits(
    { maxExecutionSec: 600, maxCostUsd: 5 },
    { elapsedMs: 1_000, runCostUsd: 5.01 },
  ), 'max_cost_exceeded');
});

test('evaluateRunLimits treats zero limits as unlimited', () => {
  assert.equal(evaluateRunLimits(
    { maxExecutionSec: 0, maxCostUsd: 0 },
    { elapsedMs: 10 * 24 * 3600 * 1000, runCostUsd: 1_000_000 },
  ), null);
});

test('evaluateRunLimits stays silent exactly at both limits (strict > semantics)', () => {
  assert.equal(evaluateRunLimits(
    { maxExecutionSec: 600, maxCostUsd: 5 },
    { elapsedMs: 600_000, runCostUsd: 5 },
  ), null);
});

test('resolveExecutionStartMs prefers a valid persisted start and falls back to the attempt start', () => {
  const persisted = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(resolveExecutionStartMs('2026-01-01T00:00:00.000Z', 123), persisted);
  assert.equal(resolveExecutionStartMs(undefined, 123), 123);
  assert.equal(resolveExecutionStartMs(null, 123), 123);
  assert.equal(resolveExecutionStartMs('not-a-date', 123), 123);
});

test('scenario maxTurns caps the run even when the enqueued resolver default is larger', { timeout: 30000 }, async () => {
  const { tmp, outputs } = setupEnvironment('arena-maxturns-');
  await syncCatalog();
  const scenarioPath = path.join(tmp, 'cap.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: cap',
    'systemPrompt: You are a test agent.',
    'task: Loop forever.',
    'maxTurns: 3',
  ].join('\n'));
  await registerRun('run-cap', outputs);

  const fake = new LoopingAdapter();
  const restore = stubAdapter(fake);
  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  try {
    const task: Task = {
      taskId: 'cap-task', sessionId: 'cap-session',
      provider: 'openai', model: 'GPT-4o', scenario: scenarioPath,
      config: { modelRunId: 'run-cap', maxTurns: 20, scenarioSource: 'cli' },
      enqueuedAt: new Date().toISOString(), attempts: 0,
    };
    await queue.enqueue(task);
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');

    const result = JSON.parse(
      fs.readFileSync(path.join(outputs, MODEL_DIR, 'run-cap', 'result.json'), 'utf8'),
    ) as { stopReason: string; turnsUsed: number; maxTurns: number };
    assert.equal(result.maxTurns, 3, 'scenario.maxTurns must beat the resolver default');
    assert.equal(result.turnsUsed, 3);
    assert.equal(result.stopReason, 'max_turns');
    assert.equal(fake.calls, 3, 'the loop must stop after the scenario turn budget');
  } finally {
    await teardown(ac, runnerDone, restore, queue, tmp);
  }
});

test('maxCostUsd breach stops the run with a distinct stop reason', { timeout: 30000 }, async () => {
  const { tmp, outputs } = setupEnvironment('arena-costlimit-');
  await syncCatalog();
  const scenarioPath = path.join(tmp, 'cost.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: cost',
    'systemPrompt: You are a test agent.',
    'task: Loop forever.',
    'executionProfile: artifact-validation',
  ].join('\n'));
  await registerRun('run-cost', outputs);

  // artifact-validation caps the run at $3; 2M input tokens at $2.5/M is $5/turn.
  const fake = new LoopingAdapter({ prompt: 2_000_000, completion: 0 });
  const restore = stubAdapter(fake);
  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  try {
    const task: Task = {
      taskId: 'cost-task', sessionId: 'cost-session',
      provider: 'openai', model: 'GPT-4o', scenario: scenarioPath,
      config: { modelRunId: 'run-cost', maxTurns: 20, scenarioSource: 'cli' },
      enqueuedAt: new Date().toISOString(), attempts: 0,
    };
    await queue.enqueue(task);
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');

    const result = JSON.parse(
      fs.readFileSync(path.join(outputs, MODEL_DIR, 'run-cost', 'result.json'), 'utf8'),
    ) as { stopReason: string; turnsUsed: number };
    assert.equal(result.stopReason, 'max_cost_exceeded');
    assert.equal(result.turnsUsed, 1, 'the cost check stops the loop before the second send');
    assert.equal(fake.calls, 1);
  } finally {
    await teardown(ac, runnerDone, restore, queue, tmp);
  }
});

test('maxExecutionSec breach stops the run with a distinct stop reason', { timeout: 30000 }, async (t) => {
  const { tmp, outputs } = setupEnvironment('arena-timelimit-');
  await syncCatalog();
  const scenarioPath = path.join(tmp, 'time.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: time',
    'systemPrompt: You are a test agent.',
    'task: Loop forever.',
  ].join('\n'));

  const fake = new LoopingAdapter();
  const restore = stubAdapter(fake);
  const queue = new InMemoryQueue();
  const ac = new AbortController();

  // read-only-analysis caps execution at 600s; jump the wall clock past it
  // inside the first send so the next turn's check trips deterministically.
  // node:test's mock Date epoch starts at 0, so the persisted run start must
  // be epoch-aligned for the wall-clock anchor to see the jump.
  t.mock.timers.enable({ apis: ['Date'] });
  fake.onCall = () => { t.mock.timers.setTime(Date.now() + 601_000); };
  await registerRun('run-time', outputs, new Date(0).toISOString());

  const runnerDone = startRunner({ queue, signal: ac.signal });

  try {
    const task: Task = {
      taskId: 'time-task', sessionId: 'time-session',
      provider: 'openai', model: 'GPT-4o', scenario: scenarioPath,
      config: { modelRunId: 'run-time', maxTurns: 20, scenarioSource: 'cli' },
      enqueuedAt: new Date().toISOString(), attempts: 0,
    };
    await queue.enqueue(task);
    // waitFor's deadline depends on Date, which this test mocks; poll instead.
    for (let i = 0; i < 400 && (await queue.size()) !== 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(await queue.size(), 0, 'task acked');

    const result = JSON.parse(
      fs.readFileSync(path.join(outputs, MODEL_DIR, 'run-time', 'result.json'), 'utf8'),
    ) as { stopReason: string; turnsUsed: number };
    assert.equal(result.stopReason, 'max_execution_time_exceeded');
    assert.equal(result.turnsUsed, 1, 'the time check stops the loop before the second send');
    assert.equal(fake.calls, 1);
  } finally {
    t.mock.timers.reset();
    await teardown(ac, runnerDone, restore, queue, tmp);
  }
});

test('maxExecutionSec counts from the persisted run start, not the attempt start', { timeout: 30000 }, async () => {
  const { tmp, outputs } = setupEnvironment('arena-runstart-');
  await syncCatalog();
  const scenarioPath = path.join(tmp, 'run-start.yaml');
  fs.writeFileSync(scenarioPath, [
    'name: run-start',
    'systemPrompt: You are a test agent.',
    'task: Loop forever.',
  ].join('\n'));
  // read-only-analysis caps execution at 600s; the run started 601s ago, so a
  // fresh attempt start would hide the breach in every retry/restart.
  await registerRun('run-old', outputs, new Date(Date.now() - 601_000).toISOString());

  const fake = new LoopingAdapter();
  const restore = stubAdapter(fake);
  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  try {
    const task: Task = {
      taskId: 'run-old-task', sessionId: 'run-old-session',
      provider: 'openai', model: 'GPT-4o', scenario: scenarioPath,
      config: { modelRunId: 'run-old', maxTurns: 20, scenarioSource: 'cli' },
      enqueuedAt: new Date().toISOString(), attempts: 0,
    };
    await queue.enqueue(task);
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');

    const result = JSON.parse(
      fs.readFileSync(path.join(outputs, MODEL_DIR, 'run-old', 'result.json'), 'utf8'),
    ) as { stopReason: string; turnsUsed: number };
    assert.equal(result.stopReason, 'max_execution_time_exceeded');
    assert.equal(result.turnsUsed, 0, 'an already-exceeded cap trips before the first send');
    assert.equal(fake.calls, 0);
  } finally {
    await teardown(ac, runnerDone, restore, queue, tmp);
  }
});
