import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { dump } from 'js-yaml';

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

const ORIG_ENV: Record<string, string | undefined> = {
  AI_ARENA_ROOT: process.env.AI_ARENA_ROOT,
  DB_DRIVER: process.env.DB_DRIVER,
  QUEUE_DRIVER: process.env.QUEUE_DRIVER,
  ARENA_DB_PATH: process.env.ARENA_DB_PATH,
  OUTPUT_ROOT: process.env.OUTPUT_ROOT,
  RUN_COST_ESTIMATE_TOKENS: process.env.RUN_COST_ESTIMATE_TOKENS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIG_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cost-estimate-'));
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = path.join(tmp, 'outputs');
  process.env.AI_ARENA_ROOT = tmp;
  process.env.DB_DRIVER = 'sqlite';
  process.env.QUEUE_DRIVER = 'memory';
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
  20 * tokensPerTurn * (2.5 + 10) / 1_000_000;

test('startRun derives its reservation estimate from RUN_COST_ESTIMATE_TOKENS', async () => {
  const tmp = freshDb();
  await seedCatalog();

  // Real budget machinery: generous limits so checkBudget allows, explicit
  // stateFile so the reservation file lands at a known path.
  fs.mkdirSync(path.join(tmp, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'configs', 'budget.yaml'), dump({
    global: { daily: 1000, monthly: 1000 },
    thresholds: { warn: 80, block: 100 },
    stateFile: '.budget-state.json',
  }));
  fs.mkdirSync(path.join(tmp, 'configs', 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'configs', 'scenarios', 'express-rest.yaml'), dump({
    name: 'express-rest', systemPrompt: 'Build an express REST api', task: 'Build an express REST api', maxTurns: 20,
  }));

  const { startRun } = await import('../../src/orchestrator/run-lifecycle.js');

  const runOnce = async (envValue: string | undefined): Promise<void> => {
    if (envValue === undefined) delete process.env.RUN_COST_ESTIMATE_TOKENS;
    else process.env.RUN_COST_ESTIMATE_TOKENS = envValue;
    await startRun({ scenario: 'express-rest', models: ['GPT-4o'], source: 'cli' });
  };

  try {
    await runOnce('12345');
    const statePath = path.join(process.env.OUTPUT_ROOT!, '.budget-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.ok(state.reservations?.['GPT-4o'], 'reservation recorded for GPT-4o');
    const first = state.reservations['GPT-4o'][0].amount as number;
    assert.ok(Math.abs(first - expected(12345)) < 1e-9,
      `env value should drive the estimate: expected ${expected(12345)}, got ${first}`);

    await runOnce(undefined);
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const second = state2.reservations['GPT-4o'][1].amount as number;
    assert.ok(Math.abs(second - expected(8000)) < 1e-9,
      `missing env should fall back to 8000: expected ${expected(8000)}, got ${second}`);
  } finally {
    restoreEnv();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
