import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { writeRunStats } from '../../src/metrics/writeback.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
};

function mockFetch(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'nf' } as unknown as Response;
  }) as typeof fetch;
}

test('writeRunStats upserts model_runtime_stats row from trace-meta + result.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wb-'));
  const dbPath = path.join(tmp, 'test.db');
  initDb(dbPath);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });

    // Simulate run output dir structure: outputs/gpt-4o/<runId>/
    const runId = 'scenario_2026-07-20T00_00_00Z';
    const modelDir = path.join(tmp, 'outputs', 'gpt-4o', runId);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'result.json'), JSON.stringify({
      model: 'gpt-4o', scenario: 'scenario', runId,
      startedAt: '2026-07-20T00:00:00.000Z', finishedAt: '2026-07-20T00:00:05.000Z',
      durationMs: 5000, turnsUsed: 2, maxTurns: 20, totalToolCalls: 1, toolsCalled: [{ name: 'read_file', count: 1 }],
      tokenUsage: { prompt: 1000, completion: 500, total: 1500, cacheReadTokens: 600 },
      stopReason: 'stop', errors: [], success: true, costUsd: 0.0075,
    }));
    fs.writeFileSync(path.join(modelDir, 'trace-meta.json'), JSON.stringify({
      traceId: 't1', spans: [
        { spanId: 's1', name: 'chat', kind: 'internal', startTime: 0, endTime: 1500, attributes: { model: 'gpt-4o' } },
        { spanId: 's2', name: 'chat', kind: 'internal', startTime: 1500, endTime: 3000, attributes: { model: 'gpt-4o' } },
        { spanId: 's3', name: 'execute_tool', kind: 'internal', startTime: 3000, endTime: 3500, attributes: { tool: 'read_file' } },
        { spanId: 's4', name: 'chat', kind: 'internal', startTime: 3500, endTime: 5000, attributes: { model: 'gpt-4o' } },
      ],
    }));

    await writeRunStats(runId, tmp);

    const rows = getDb().prepare('SELECT * FROM model_runtime_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.success, 1);
    assert.equal(row.cost_usd, 0.0075);
    assert.ok(row.tps, 'tps should be set');
    assert.ok(row.cache_hit_rate, 'cache_hit_rate should be set');
    assert.equal(row.cache_read_tokens, 600);
    assert.equal(row.latency_p50_ms, 1500); // median of [1500, 1500, 3000] chat durations
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
