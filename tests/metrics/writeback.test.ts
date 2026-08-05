import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { writeRunStats } from '../../src/metrics/writeback.js';
import { upsertRun } from '../../src/db/runs.js';
import { createSessionStore } from '../../src/session/store.js';
import type { FetchInput } from '../helpers/fetch-types.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
    'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 3, output: 15 }, limit: { context: 200000, output: 8192 } },
  } },
};

function mockFetch(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: FetchInput) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'nf' } as unknown as Response;
  }) as typeof fetch;
}

function modelRunDir(tmp: string, model: string, runId: string): string {
  return path.join(tmp, 'outputs', model, runId);
}

function seedRunOutputs(tmp: string, model: string, runId: string, extra: Record<string, unknown> = {}): void {
  const dir = modelRunDir(tmp, model, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    model, scenario: 'scenario', runId,
    startedAt: '2026-07-20T00:00:00.000Z', finishedAt: '2026-07-20T00:00:05.000Z',
    durationMs: 5000, turnsUsed: 2, maxTurns: 20, totalToolCalls: 1, toolsCalled: [{ name: 'read_file', count: 1 }],
    tokenUsage: { prompt: 1000, completion: 500, total: 1500, cacheReadTokens: 600 },
    stopReason: 'stop', errors: [], success: true, costUsd: 0.0075,
    ...extra,
  }));
  fs.writeFileSync(path.join(dir, 'trace-meta.json'), JSON.stringify({
    traceId: 't1', spans: [
      { spanId: 's1', name: 'chat', type: 'chat', startedAt: 0, endedAt: 1500, durationMs: 1500, status: 'ok', attributes: { model } },
      { spanId: 's2', name: 'chat', type: 'chat', startedAt: 1500, endedAt: 3000, durationMs: 1500, status: 'ok', attributes: { model } },
      { spanId: 's3', name: 'execute_tool', type: 'execute_tool', startedAt: 3000, endedAt: 3500, durationMs: 500, status: 'ok', attributes: { tool: 'read_file' } },
      { spanId: 's4', name: 'chat', type: 'chat', startedAt: 3500, endedAt: 5000, durationMs: 1500, status: 'ok', attributes: { model } },
    ],
  }));
}

async function registerRun(tmp: string, runId: string, models: string[]): Promise<void> {
  await upsertRun({
    runId, scenario: 'scenario', models,
    startedAt: '2026-07-20T00:00:00.000Z', finishedAt: '2026-07-20T00:00:05.000Z',
    status: 'completed', source: 'cli',
    perModel: models.map((m) => ({
      model: m, runId,
      outputDir: modelRunDir(tmp, m, runId),
      sandboxDir: path.join(modelRunDir(tmp, m, runId), 'files'),
      resultPath: path.join(modelRunDir(tmp, m, runId), 'result.json'),
      conversationPath: '', reportPath: '', logFile: '',
      status: 'completed' as const, success: true, durationMs: 5000,
    })),
    comparisonMdPath: null, comparisonJsonPath: null,
  });
}

async function seedModelCall(runId: string, model: string, ttftMs: number): Promise<void> {
  const store = createSessionStore();
  const s = await store.createSession({ id: `${runId}-${model}`, model });
  await store.recordModelCall({
    sessionId: s.id, turn: 1, provider: model.startsWith('claude') ? 'anthropic' : 'openai', model,
    requestHash: `h-${model}`, responseText: 'hello', usage: { prompt: 1000, completion: 500 },
    latencyMs: 1500, ttftMs,
  });
}

test('writeRunStats upserts model_runtime_stats from run index + model_calls (ttft)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wb-'));
  const dbPath = path.join(tmp, 'test.db');
  initDb(dbPath);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });

    const runId = 'scenario_2026-07-20T00_00_00Z';
    seedRunOutputs(tmp, 'gpt-4o', runId);
    await registerRun(tmp, runId, ['gpt-4o']);
    await seedModelCall(runId, 'gpt-4o', 120);

    await writeRunStats(runId, tmp);

    // After writeRunStats, close the drizzle connection to force flush
    closeDb();
    initDb(dbPath);
    const rows = getDb().prepare('SELECT * FROM model_runtime_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.model_id, 'openai/gpt-4o');
    assert.equal(row.ttft_ms, 120);
    assert.equal(row.success, 1);
    assert.equal(row.cost_usd, 0.0075);
    assert.ok(row.tps, 'tps should be set');
    assert.ok(row.cache_hit_rate, 'cache_hit_rate should be set');
    assert.equal(row.cache_read_tokens, 600);
    assert.equal(row.latency_p50_ms, 1500);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeRunStats writes stats for BOTH models in a multi-model run from the run index', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wb-'));
  const dbPath = path.join(tmp, 'test.db');
  initDb(dbPath);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });

    const runId = 'scenario_2026-07-20T00_00_00Z';
    seedRunOutputs(tmp, 'gpt-4o', runId);
    seedRunOutputs(tmp, 'claude-3-5-sonnet', runId);
    await registerRun(tmp, runId, ['gpt-4o', 'claude-3-5-sonnet']);
    await seedModelCall(runId, 'gpt-4o', 120);
    await seedModelCall(runId, 'claude-3-5-sonnet', 250);

    await writeRunStats(runId, tmp);

    closeDb();
    initDb(dbPath);
    const rows = getDb().prepare('SELECT * FROM model_runtime_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2, 'expected one stats row per model in the run');
    const byModel: Record<string, Record<string, unknown>> = {};
    for (const r of rows) byModel[String(r.model_id)] = r;
    assert.equal(byModel['openai/gpt-4o']?.ttft_ms, 120);
    assert.equal(byModel['anthropic/claude-3-5-sonnet']?.ttft_ms, 250);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tool_call_stats.model stores the canonical model id matching model_runtime_stats.model_id', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wb-'));
  const dbPath = path.join(tmp, 'test.db');
  initDb(dbPath);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });

    const runId = 'scenario_2026-07-20T00_00_00Z';
    // result.json uses the non-canonical display name 'GPT-4o'
    seedRunOutputs(tmp, 'gpt-4o', runId, {
      model: 'GPT-4o',
      toolSuccessRates: { read_file: { success: 1, fail: 0 } },
    });
    await registerRun(tmp, runId, ['gpt-4o']);
    await seedModelCall(runId, 'gpt-4o', 50);

    await writeRunStats(runId, tmp);

    closeDb();
    initDb(dbPath);
    const tcs = getDb().prepare('SELECT * FROM tool_call_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(tcs.length, 1);
    assert.equal(tcs[0]!.model, 'openai/gpt-4o', 'tool_call_stats.model must use the canonical model id');
    const rs = getDb().prepare('SELECT model_id FROM model_runtime_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(rs[0]!.model_id, tcs[0]!.model);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
