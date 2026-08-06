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
import { ProviderRegistry } from '../../src/providers/index.js';
import type { CreateAdapterOpts } from '../../src/providers/registry.js';
import type { ModelAdapter } from '../../src/providers/adapters/base.js';
import { taskCounter, taskDuration, activeTasks } from '../../src/observability/metrics.js';

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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Fake adapter: returns a single `task_complete` tool call so the agent loop
 * terminates after turn 1 without touching any real provider or tool beyond
 * the task_complete executor. Never performs network I/O.
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

test('runner executes a full happy path: ack, session, result.json, metrics, completed', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-happy-'));
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

  // Minimal scenario WITHOUT successCriteria/starterFiles so the happy path
  // is fully deterministic: no shell commands, no template seeding, and
  // `success` comes straight from the loop's task_complete stop reason.
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

  // run_models row must exist before the runner's transitionTaskState UPDATEs.
  // Full per-model paths so the runner's self-finalize (finalizeRunByRunId)
  // can read the real result.json and keeps the model 'completed' instead of
  // marking it 'errored' from an unreadable result path.
  const modelRunDir = path.join(outputs, 'GPT-4o', 'run15');
  await upsertRun({
    runId: 'run15', scenario: 'smoke', models: ['GPT-4o'],
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', source: 'cli',
    perModel: [{
      model: 'GPT-4o', runId: 'run15', status: 'running',
      outputDir: modelRunDir,
      sandboxDir: path.join(modelRunDir, 'files'),
      resultPath: path.join(modelRunDir, 'result.json'),
      conversationPath: path.join(modelRunDir, 'conversation.json'),
      reportPath: path.join(modelRunDir, 'report.md'),
      logFile: path.join(modelRunDir, 'runner.log'),
    }],
    comparisonMdPath: null, comparisonJsonPath: null,
  });

  // Route every adapter creation to the fake — no provider network calls.
  const fake = new FakeAdapter();
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  const task: Task = {
    taskId: 'happy-task',
    sessionId: 'happy-session',
    provider: 'openai',
    model: 'GPT-4o',
    scenario: scenarioPath,
    config: { modelRunId: 'run15', maxTurns: 5 },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  };

  try {
    await queue.enqueue(task);

    // The queue drains and the run finalizes as 'completed'.
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    await waitFor(() => {
      const row = getDb().prepare('SELECT status, completed_at FROM run_models WHERE run_id = ? AND model = ?')
        .get('run15', 'GPT-4o') as { status: string; completed_at: string | null } | undefined;
      return row?.status === 'completed';
    }, 10000, 'run_models status completed');

    // 1. Task acked, nothing left pending/in-flight/DLQ.
    assert.equal(await queue.size(), 0);
    assert.equal(await queue.deadLetterSize(), 0, 'happy path must ack, not nack');

    // 2. Run marked completed with a completion timestamp.
    const runRow = getDb().prepare('SELECT status, completed_at FROM run_models WHERE run_id = ? AND model = ?')
      .get('run15', 'GPT-4o') as { status: string; completed_at: string | null };
    assert.equal(runRow.status, 'completed');
    assert.ok(runRow.completed_at, 'completed_at should be set');

    // 3. result.json written with a successful task_complete outcome.
    const resultPath = path.join(outputs, 'GPT-4o', 'run15', 'result.json');
    assert.ok(fs.existsSync(resultPath), 'result.json should exist');
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      success: boolean; stopReason: string; turnsUsed: number;
      totalToolCalls: number; errors: unknown[]; toolsCalled: { name: string; count: number }[];
    };
    assert.equal(result.success, true);
    assert.equal(result.stopReason, 'task_complete');
    assert.equal(result.turnsUsed, 1, 'loop should stop after a single turn');
    assert.equal(result.totalToolCalls, 1, 'exactly one tool call (task_complete)');
    assert.deepEqual(result.toolsCalled, [{ name: 'task_complete', count: 1 }]);
    assert.deepEqual(result.errors, []);
    for (const artifact of ['conversation.json', 'report.md', 'artifact-manifest.json']) {
      assert.ok(fs.existsSync(path.join(outputs, 'GPT-4o', 'run15', artifact)), `${artifact} should exist`);
    }

    // 4. Session persisted: turn-0 system+task, turn-1 assistant + tool result,
    //    and the session ends 'completed'.
    const session = getDb().prepare('SELECT id, status FROM sessions WHERE model = ?').get('GPT-4o') as
      { id: string; status: string } | undefined;
    assert.ok(session, 'session should be persisted');
    assert.equal(session.status, 'completed');
    const messages = getDb().prepare('SELECT role, turn, content, tool_calls FROM messages WHERE session_id = ? ORDER BY turn, rowid')
      .all(session.id) as { role: string; turn: number; content: string | null; tool_calls: string | null }[];
    assert.ok(messages.length >= 2, `expected >= 2 messages, got ${messages.length}`);
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'], 'turn 0 + turn 1 roles');
    const assistant = messages.find((m) => m.role === 'assistant');
    const toolCalls = JSON.parse(assistant?.tool_calls ?? '[]') as { name: string }[];
    assert.equal(toolCalls[0]?.name, 'task_complete');

    // 5. Metrics counters incremented for the completed run.
    const counted = (await taskCounter.get()).values.find(
      (m) => m.labels.model === 'GPT-4o' && m.labels.status === 'completed',
    );
    assert.ok(counted && counted.value >= 1, 'taskCounter should record a completed GPT-4o task');
    const duration = (await taskDuration.get()).values.find(
      (m) => m.labels.model === 'GPT-4o' && m.metricName?.endsWith('_sum'),
    );
    assert.ok(duration && duration.value > 0, 'taskDuration should be observed for GPT-4o');

    // 6. The fake adapter was consulted exactly once — the loop really ran
    //    through the send→tool→complete path and stopped.
    assert.equal(fake.calls, 1, 'fake adapter should be called exactly once');
  } finally {
    ac.abort();
    await runnerDone;
    ProviderRegistry.prototype.createAdapter = origCreateAdapter;
    const active = await activeTasks.get();
    assert.equal(active.values[0]?.value, 0, 'no task should leak after shutdown');
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});

test('runner finalizes its own run when the dashboard watcher is absent', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-self-finalize-'));
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

  // Register the run with full per-model paths so the self-finalize's
  // comparison aggregation reads the real result.json the runner writes.
  const runId = 'run-self-finalize';
  const modelRunDir = path.join(outputs, 'GPT-4o', runId);
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

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  const task: Task = {
    taskId: 'self-finalize-task',
    sessionId: 'self-finalize-session',
    provider: 'openai',
    model: 'GPT-4o',
    scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5 },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  };

  try {
    await queue.enqueue(task);

    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');

    // No dashboard watcher runs here — the runner itself must finalize the
    // run (status 'completed' + comparison artifacts) once the task reaches
    // a terminal state.
    const { getRunRecord } = await import('../../src/db/runs.js');
    const comparisonMdPath = path.join(outputs, 'comparisons', `${runId}.md`);
    const comparisonJsonPath = path.join(outputs, 'comparisons', `${runId}.json`);
    await waitFor(async () => (await getRunRecord(runId))?.status === 'completed',
      10000, 'run self-finalized to completed');

    const rec = await getRunRecord(runId);
    assert.ok(rec, 'run record should exist');
    assert.equal(rec.status, 'completed', 'run must be finalized by the runner itself');
    assert.equal(rec.comparisonMdPath, comparisonMdPath, 'comparison md path recorded');
    assert.equal(rec.comparisonJsonPath, comparisonJsonPath, 'comparison json path recorded');
    assert.ok(fs.existsSync(comparisonMdPath), 'comparison markdown must exist after self-finalize');
    assert.ok(fs.existsSync(comparisonJsonPath), 'comparison json must exist after self-finalize');
    const md = fs.readFileSync(comparisonMdPath, 'utf8');
    assert.match(md, /PASS/, 'comparison must aggregate the completed run as a pass');
  } finally {
    ac.abort();
    await runnerDone;
    ProviderRegistry.prototype.createAdapter = origCreateAdapter;
    const active = await activeTasks.get();
    assert.equal(active.values[0]?.value, 0, 'no task should leak after shutdown');
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIG_ENV };
  }
});
