import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { fetchBenchmarks } from '../../src/catalog/benchmarks.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
};

const MODELBENCH_PAGE1 = {
  data: [{
    slug: 'openai/gpt-4o', name: 'GPT-4o', developer: 'OpenAI',
    intelligence_score: 75.2, coding_score: 80.1, agentic_score: 72.0, speed_tps: 48.0,
    benchmark_data: { 'Intelligence Index': 75.2, 'Coding Score': 80.1, 'GPQA Diamond': 60.5 },
    source: 'https://modelbench.lol/models/openai/gpt-4o',
  }],
  meta: { page: 1, limit: 50, total: 1 },
};

const ZEROEVAL = {
  'gpt-4o': { model_name: 'GPT-4o', swebench: 33.5, gpqa: 53.6, mmlu: 88.7 },
};

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bench-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

function mockFetchImpl(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) {
        return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
      }
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'not found' } as unknown as Response;
  }) as typeof fetch;
}

test('fetchBenchmarks modelbench upserts benchmark rows with is_preferred flags', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchImpl({
    'models.dev/api.json': () => MODELS_DEV,
    'modelbench.lol/api/v1/models': () => MODELBENCH_PAGE1,
  });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const result = await fetchBenchmarks('modelbench', { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 5);
    const rows = getDb().prepare('SELECT benchmark, source, score, is_preferred FROM benchmarks ORDER BY benchmark').all() as Array<{ benchmark: string; source: string; score: number; is_preferred: number }>;
    assert.equal(rows.length, 5);
    const ii = rows.find(r => r.benchmark === 'Intelligence Index')!;
    assert.equal(ii.is_preferred, 1);
    const gpqa = rows.find(r => r.benchmark === 'GPQA Diamond')!;
    assert.equal(gpqa.is_preferred, 0);
    const cs = rows.find(r => r.benchmark === 'Coding Score')!;
    assert.equal(cs.is_preferred, 1);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchBenchmarks zeroeval upserts benchmark rows with is_preferred=0 for overlap', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchImpl({
    'models.dev/api.json': () => MODELS_DEV,
    'api.zeroeval.com/leaderboard/models/full': () => ZEROEVAL,
  });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const result = await fetchBenchmarks('zeroeval', { force: true });
    assert.equal(result.ok, true);
    const rows = getDb().prepare('SELECT benchmark, source, score, is_preferred FROM benchmarks ORDER BY benchmark').all() as Array<{ benchmark: string; source: string; score: number; is_preferred: number }>;
    assert.ok(rows.length >= 3);
    for (const r of rows) assert.equal(r.is_preferred, 0, `${r.benchmark} should not be preferred from zeroeval`);
    const swe = rows.find(r => r.benchmark === 'SWE-bench');
    assert.ok(swe);
    assert.equal(swe!.score, 33.5);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchBenchmarks records error status on fetch failure', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 500, ok: false, json: async () => ({}), text: async () => 'err' } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchBenchmarks('modelbench', { force: true });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});
