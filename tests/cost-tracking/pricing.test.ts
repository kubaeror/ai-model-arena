import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDrizzleClient } from '../../src/db/client.js';
import { pricing } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { fetchSync } from '../../src/catalog/sync.js';
import { getModelPricing, getPricing, computeCost, formatCost, resetPricingCache } from '../../src/cost-tracking/pricing.js';
import type { CostTokenUsage } from '../../src/cost-tracking/types.js';

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
    'gpt-cw': {
      id: 'gpt-cw', name: 'GPT-CW',
      attachment: false, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2, output: 8, cache_write: 0.75 },
      limit: { context: 128000, output: 16384 },
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
    const c = await computeCost('openai/gpt-4o', {} as unknown as CostTokenUsage);
    assert.equal(c.total, 0);
  } finally { closeDb(); cleanup(); }
});

test('formatCost formats small/large amounts', () => {
  assert.equal(formatCost(0.0005), '$0.000500');
  assert.equal(formatCost(0.123456), '$0.1235');
  assert.equal(formatCost(12.5), '$12.50');
});

test('over-200k output cost uses the tier output price, not the input fallback', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    // Null out over_200k_output and add a tier row with its own output price.
    const db = getDrizzleClient();
    await db.update(pricing).set({ over_200k_output: null }).where(eq(pricing.model_id, 'openai/gpt-x'));
    await db.insert(pricing).values({
      model_id: 'openai/gpt-x', tier_size: 200001,
      input: 1.25, output: 7.5, cache_read: 0.5, cache_write: null,
      over_200k_input: null, over_200k_output: null,
      over_200k_cache_read: null, over_200k_cache_write: null,
      updated_at: new Date().toISOString(),
    });
    const c = await computeCost('openai/gpt-x', { prompt: 250000, completion: 1000 });
    assert.equal(c.inputCost, 375); // 250000/1000 * 1.5
    assert.equal(c.outputCost, 7.5); // largest tier output, not the over-200k input price
    assert.equal(c.total, 382.5);
  } finally { closeDb(); cleanup(); }
});

test('getPricing exposes cache_write and computeCost uses it when cache_read is missing', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    const p = await getPricing('openai/gpt-cw');
    assert.equal(p?.cache_write, 0.75);
    const c = await computeCost('openai/gpt-cw', { prompt: 0, completion: 0, cached: 2000 });
    assert.equal(c.cachedCost, 1.5); // 2000/1000 * 0.75
  } finally { closeDb(); cleanup(); }
});

test('resetPricingCache clears the pricing cache and re-lookup re-fetches', async () => {
  const cleanup = freshDb();
  try {
    await seed();
    assert.equal((await getPricing('openai/gpt-4o'))?.input, 2.5);

    const db = getDrizzleClient();
    await db.update(pricing).set({ input: 9 }).where(eq(pricing.model_id, 'openai/gpt-4o'));

    assert.equal((await getPricing('openai/gpt-4o'))?.input, 2.5, 'cached value served until reset');
    resetPricingCache();
    assert.equal((await getPricing('openai/gpt-4o'))?.input, 9, 're-lookup re-fetches after reset');
  } finally { closeDb(); cleanup(); }
});
