import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';
import { startRunner } from '../../src/runner.js';
import { upsertRun } from '../../src/db/runs.js';

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

test('runner dequeues and nacks an unresolvable model into the DLQ', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-runner-'));
  const outputs = path.join(tmp, 'outputs');
  const dbFile = path.join(tmp, 'test.db');
  process.env.ARENA_DB_PATH = dbFile;
  process.env.OUTPUT_ROOT = outputs;
  process.env.RUNNER_METRICS_ENABLED = 'false';
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
  } finally {
    ac.abort();
    await runnerDone;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});
