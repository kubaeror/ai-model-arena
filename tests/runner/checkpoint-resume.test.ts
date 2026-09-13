import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';
import { resumeFrom } from '../../src/runner/checkpoint.js';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter } from '../../src/providers/adapters/base.js';
import type { ChatMessage } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';
import { startRunner } from '../../src/runner.js';
import { upsertRun } from '../../src/db/runs.js';
import { ProviderRegistry } from '../../src/providers/index.js';
import type { CreateAdapterOpts } from '../../src/providers/registry.js';

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

function stubToolCtx() {
  return { sandboxDir: '/tmp', logger: stubLogger(), shellTimeoutMs: 10000, maxShellOutputBytes: 524288 };
}

test('resumeFrom returns empty messages + lastCompletedTurn -1 for fresh session', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  const result = await resumeFrom(s.id);
  assert.deepStrictEqual(result.messages, []);
  assert.equal(result.lastCompletedTurn, -1);
  closeDb();
});

test('resumeFrom returns stored messages and computes lastCompletedTurn', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });

  await store.appendMessage(s.id, {
    id: 'm1', sessionId: s.id, turn: 0, role: 'user',
    content: 'task', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  await store.appendMessage(s.id, {
    id: 'm2', sessionId: s.id, turn: 1, role: 'user',
    content: 'more', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 2);
  assert.equal(result.lastCompletedTurn, 1);
  closeDb();
});

test('resumeFrom returns chat messages with toolCalls parsed from JSON', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });

  await store.appendMessage(s.id, {
    id: 'm3', sessionId: s.id, turn: 1, role: 'assistant',
    content: null,
    toolCalls: JSON.stringify([{ id: 'tc1', name: 'list_files', arguments: {} }]),
    toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 1);
  const msg = result.messages[0]!;
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, null);
  assert.ok(msg.toolCalls);
  assert.equal(msg.toolCalls![0]!.name, 'list_files');
  closeDb();
});

test('resumeFrom handles multi-turn with mixed completed turns', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'claude-3' });

  await store.appendMessage(s.id, {
    id: 'm1', sessionId: s.id, turn: 0, role: 'user', content: 'hello',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 0, provider: 'anthropic', model: 'claude-3',
    requestHash: 'h1', responseText: 'hi', usage: null, latencyMs: 100,
  });

  await store.appendMessage(s.id, {
    id: 'm2', sessionId: s.id, turn: 1, role: 'user', content: 'build',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 1, provider: 'anthropic', model: 'claude-3',
    requestHash: 'h2', responseText: 'building', usage: null, latencyMs: 150,
  });

  await store.appendMessage(s.id, {
    id: 'm3', sessionId: s.id, turn: 2, role: 'user', content: 'finish',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 3);
  assert.equal(result.lastCompletedTurn, 2);
  closeDb();
});

test('runAgentLoop resumed from checkpoint does not duplicate system+user entries in the conversation', async () => {
  const systemPrompt = 'You are a coding agent.';
  const task = 'Build a feature.';

  // Messages as resumeFrom() would return them: the initial pair plus one completed turn.
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
    { role: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'list_files', arguments: {} }] },
    { role: 'tool', toolCallId: 'tc1', name: 'list_files', content: '[]' },
  ];

  // Conversation already persisted by the original run (system+user pair).
  const entries: any[] = [
    { type: 'system', role: 'system', content: systemPrompt },
    { type: 'user', role: 'user', content: task },
  ];
  const conv = {
    append: (e: any) => entries.push({ ...e, timestamp: e.timestamp ?? new Date().toISOString() }),
    flush: () => {},
    setEnded: () => {},
  } as unknown as ConversationLogger;

  const adapter: ModelAdapter = {
    sendMessage: async () => ({ text: 'done', toolCalls: [], usage: { prompt: 10, completion: 5 }, stopReason: 'no_tool_calls' }),
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };

  await runAgentLoop({
    adapter, tools: [], executors: {},
    systemPrompt, task, maxTurns: 5,
    toolCtx: stubToolCtx(), conv, logger: stubLogger(),
    initialMessages,
  });

  const systemPromptEntries = entries.filter((e) => e.role === 'system' && e.content === systemPrompt);
  const taskEntries = entries.filter((e) => e.role === 'user' && e.content === task);
  assert.equal(systemPromptEntries.length, 1, `system prompt duplicated on resume: ${systemPromptEntries.length} entries`);
  assert.equal(taskEntries.length, 1, `task duplicated on resume: ${taskEntries.length} entries`);
  assert.ok(entries.some((e) => e.content === '[resumed from checkpoint]'), 'expected "[resumed from checkpoint]" marker entry');
});

test('sumPriorRunSpend accumulates usage JSON across persisted model calls', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });

  // computeCost reads pricing from the catalog DB — seed providers/models/pricing.
  const { getDrizzleDb } = await import('../../src/db/index.js');
  const { providers, models, pricing } = await import('../../src/db/schema.js');
  const now = new Date().toISOString();
  await getDrizzleDb().insert(providers).values({
    id: 'openai', name: 'OpenAI', api_base: null, auth_scheme: 'bearer',
    env_var: 'OPENAI_API_KEY', is_builtin: 1, adapter: 'openai-compat',
    header_name: null, created_at: now, updated_at: now,
  });
  await getDrizzleDb().insert(models).values({
    id: 'gpt-4o', name: 'gpt-4o', family: null, provider_id: 'openai',
    release_date: null, attachment: 0, reasoning: 0, temperature: 0,
    tool_call: 1, interleaved: null, status: 'active',
    context_limit: 128000, input_limit: null, output_limit: 16384,
    modalities: null, reasoning_options: null, source_json: null,
    last_synced_at: now,
  });
  await getDrizzleDb().insert(pricing).values({
    model_id: 'gpt-4o', tier_size: 0,
    input: 2.5, output: 10, cache_read: 0, cache_write: 0,
    over_200k_input: null, over_200k_output: null,
    over_200k_cache_read: null, over_200k_cache_write: null,
    updated_at: now,
  });

  await store.recordModelCall({
    sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o',
    requestHash: 'h1', responseText: 'a',
    usage: { prompt: 1000, completion: 500, total: 1500 }, latencyMs: 10,
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 1, provider: 'openai', model: 'gpt-4o',
    requestHash: 'h2', responseText: 'b',
    usage: { prompt: 2000, completion: 1000, total: 3000 }, latencyMs: 10,
  });

  const { sumPriorRunSpend } = await import('../../src/runner.js');
  const total = await sumPriorRunSpend(s.id, 'gpt-4o');
  // computeCost units: (tokens/1M) * price. call1: 2.5*1000/1M + 10*500/1M
  // = 0.0075, call2: 2.5*2000/1M + 10*1000/1M = 0.015. The helper mirrors the
  // loop's max-per-call convention, so the seed data yields exactly 0.015.
  assert.equal(total, 0.015, 'prior spend should equal the max per-call cost');
  closeDb();
});

const RESUME_MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': {
      id: 'gpt-4o', name: 'GPT-4o',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 3.75 },
      limit: { context: 128000, output: 16384 },
    },
  } },
};

const RESUME_MODEL_DIR = 'openai_gpt-4o';
const RESUME_ORIG_ENV = { ...process.env };

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('runner resume bills cache tokens per call and reports the absolute final turn', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-resume-cost-'));
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
    json: async () => RESUME_MODELS_DEV,
    text: async () => JSON.stringify(RESUME_MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }

  // Partially completed session: turn 1 persisted, so the runner resumes at turn 2.
  const store = createSessionStore();
  const sessionId = 'resume-cost-session';
  const session = await store.createSession({ id: sessionId, model: 'GPT-4o' });
  const now = new Date().toISOString();
  await store.appendMessage(session.id, { id: 'r0', sessionId: session.id, turn: 0, role: 'system', content: 'You are a test agent.', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: now });
  await store.appendMessage(session.id, { id: 'r1', sessionId: session.id, turn: 0, role: 'user', content: 'Finish immediately.', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: now });
  await store.appendMessage(session.id, { id: 'r2', sessionId: session.id, turn: 1, role: 'assistant', content: 'partial', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: now });
  await store.recordModelCall({
    sessionId: session.id, turn: 1, provider: 'openai', model: 'GPT-4o',
    requestHash: 'prior', responseText: 'partial',
    usage: { prompt: 1000, completion: 100, total: 1100, cacheReadTokens: 400 }, latencyMs: 10,
  });

  const runId = 'run-resume-cost';
  const modelRunDir = path.join(outputs, RESUME_MODEL_DIR, runId);
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

  const fake: ModelAdapter & { calls: number } = {
    calls: 0,
    sendMessage: async () => {
      fake.calls++;
      return {
        text: 'done',
        toolCalls: [{ id: 'fake-tc-1', name: 'task_complete', arguments: { summary: 'done' } }],
        usage: { prompt: 12, completion: 6, total: 18, cacheReadTokens: 4, cacheWriteTokens: 2 },
        stopReason: 'tool_calls',
      };
    },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };
  const origCreateAdapter = ProviderRegistry.prototype.createAdapter;
  ProviderRegistry.prototype.createAdapter = function (_providerId: string, _modelId: string, _opts: CreateAdapterOpts): ModelAdapter {
    return fake;
  };

  const queue = new InMemoryQueue();
  const ac = new AbortController();
  const runnerDone = startRunner({ queue, signal: ac.signal });

  const task: Task = {
    taskId: 'resume-cost-task',
    sessionId,
    provider: 'openai',
    model: 'GPT-4o',
    scenario: scenarioPath,
    config: { modelRunId: runId, maxTurns: 5, scenarioSource: 'cli' },
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  };

  try {
    await queue.enqueue(task);
    await waitFor(async () => (await queue.size()) === 0, 10000, 'task acked');
    await waitFor(() => {
      const row = getDb().prepare('SELECT status FROM run_models WHERE run_id = ? AND model = ?')
        .get(runId, 'GPT-4o') as { status: string } | undefined;
      return row?.status === 'completed';
    }, 10000, 'run_models status completed');

    const result = JSON.parse(fs.readFileSync(path.join(modelRunDir, 'result.json'), 'utf8')) as {
      turnsUsed: number;
      tokenUsage: { prompt?: number; completion?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
      costUsd?: number;
    };

    // Problem C: turn-loop reports absolute turns, so the resumed run's final
    // turn is 2 — not 2 + (initialTurn - 1) = 3.
    assert.equal(result.turnsUsed, 2, 'resumed run must report the absolute final turn');

    // Problem A: cache tokens survive the loop and are billed.
    assert.equal(result.tokenUsage.cacheReadTokens, 4);
    assert.equal(result.tokenUsage.cacheWriteTokens, 2);
    const expected = (12 - 4 - 2) / 1e6 * 2.5 + 6 / 1e6 * 10 + 4 / 1e6 * 1.25 + 2 / 1e6 * 3.75;
    assert.ok(
      typeof result.costUsd === 'number' && Math.abs(result.costUsd - expected) < 1e-12,
      `costUsd ${result.costUsd} should equal ${expected}`,
    );
    assert.equal(fake.calls, 1, 'fake adapter should be called exactly once');
  } finally {
    ac.abort();
    await runnerDone;
    ProviderRegistry.prototype.createAdapter = origCreateAdapter;
    await queue.close();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...RESUME_ORIG_ENV };
  }
});
