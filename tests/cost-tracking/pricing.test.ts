import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { getModelPricing, getPricing, computeCost, formatCost } from '../../src/cost-tracking/pricing.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': {
      id: 'gpt-4o', name: 'GPT-4o',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10, cache_read: 1.25 },
      limit: { context: 128000, output: 16384 },
    },
    'gpt-x': {
      id: 'gpt-x', name: 'GPT-X',
      attachment: false, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10, cache_read: 1.25, context_over_200k: { input: 1.5, output: 5, cache_read: 0.5 } },
      limit: { context: 400000, output: 16384 },
    },
  } },
};

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-pricing-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

async function seed() {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  globalThis.fetch = origFetch;
}

test('getModelPricing returns direct pricing for a canonical id', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const p = await getModelPricing('openai/gpt-4o');
    assert.ok(p);
    assert.equal(p.input, 2.5);
    assert.equal(p.output, 10);
    assert.equal(p.cache_read, 1.25);
  } finally { closeDb(); cleanup(); }
});

test('getModelPricing falls back to resolving by friendly name', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const p = await getModelPricing('GPT-4o');
    assert.ok(p);
    assert.equal(p.input, 2.5);
  } finally { closeDb(); cleanup(); }
});

test('getModelPricing returns null for unknown models', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    assert.equal(await getModelPricing('nope/nothing'), null);
    assert.equal(await getModelPricing('Definitely Not A Model'), null);
    assert.equal(await getPricing('Definitely Not A Model'), undefined);
  } finally { closeDb(); cleanup(); }
});

test('computeCost computes per-1000-token costs', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    // 1000 prompt @ 2.5 + 500 completion @ 10 + 200 cached @ 1.25
    const c = await computeCost('openai/gpt-4o', { prompt: 1000, completion: 500, cached: 200 });
    assert.equal(c.inputCost, 2.5);
    assert.equal(c.outputCost, 5);
    assert.equal(c.cachedCost, 0.25);
    assert.equal(c.total, 7.75);
  } finally { closeDb(); cleanup(); }
});

test('computeCost returns zeros when model has no pricing', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const c = await computeCost('unknown-model', { prompt: 1000, completion: 500 });
    assert.deepEqual(c, { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 });
  } finally { closeDb(); cleanup(); }
});

test('computeCost uses over-200k tier when total tokens exceed 200k', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const c = await computeCost('openai/gpt-x', { prompt: 250000, completion: 0 });
    // tier input 1.5 per 1k
    assert.equal(c.inputCost, 375);
    assert.equal(c.total, 375);
  } finally { closeDb(); cleanup(); }
});

test('computeCost handles null usage fields', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const c = await computeCost('openai/gpt-4o', {});
    assert.equal(c.total, 0);
  } finally { closeDb(); cleanup(); }
});

test('formatCost formats small/large amounts', () => {
  assert.equal(formatCost(0.0005), '$0.000500');
  assert.equal(formatCost(0.123456), '$0.1235');
  assert.equal(formatCost(12.5), '$12.50');
});
