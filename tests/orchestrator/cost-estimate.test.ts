import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';

const MODELS_DEV = {
  openai: {
    id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: true, reasoning: false, temperature: true, tool_call: true,
        cost: { input: 2.5, output: 10 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};

const PRICING = { input: 2.5, output: 10, cached: 0 };

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cost-estimate-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  initDb(process.env.ARENA_DB_PATH);
  return tmp;
}

async function seedCatalog(): Promise<void> {
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

const expected = (tokensPerTurn: number): number =>
  20 * tokensPerTurn * (PRICING.input + PRICING.output) / 1_000_000;

/**
 * Mock the cost-tracking module so startRun's reserveBudget calls are captured.
 * NOTE: run-lifecycle.js must be imported exactly once, after this mock is
 * registered — an already-loaded importer keeps its original bindings, so a
 * per-test re-mock would be silently ignored on the second test.
 */
test('startRun derives its reservation estimate from RUN_COST_ESTIMATE_TOKENS', async (t) => {
  const tmp = freshDb();
  await seedCatalog();
  const captured: number[] = [];
  t.mock.module('../../src/cost-tracking/index.js', {
    exports: {
      loadBudgetConfig: () => {},
      checkBudget: () => ({ allowed: true, spentUsd: 0, limitUsd: 10, percentUsed: 0 }),
      reserveBudget: (_model: string, estimated: number) => {
        captured.push(estimated);
        return { ok: true };
      },
      releaseReservation: () => {},
      getPricing: async () => PRICING,
    },
  });
  const { startRun } = await import('../../src/orchestrator/run-lifecycle.js');

  const runOnce = async (envValue: string | undefined): Promise<void> => {
    if (envValue === undefined) delete process.env.RUN_COST_ESTIMATE_TOKENS;
    else process.env.RUN_COST_ESTIMATE_TOKENS = envValue;
    await startRun({ scenario: 'express-rest', models: ['GPT-4o'], source: 'cli' });
  };

  try {
    await runOnce('12345');
    assert.equal(captured[0], expected(12345), 'env value should drive the estimate');

    await runOnce(undefined);
    assert.equal(captured[1], expected(8000), 'missing env should fall back to 8000');

    await runOnce('not-a-number');
    assert.equal(captured[2], expected(8000), 'non-numeric env should fall back to 8000');

    await runOnce('0');
    assert.equal(captured[3], expected(1), 'env below 1 should clamp to 1');

    await runOnce('-5');
    assert.equal(captured[4], expected(1), 'negative env should clamp to 1');
  } finally {
    delete process.env.RUN_COST_ESTIMATE_TOKENS;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
