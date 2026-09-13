import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb, getDrizzleClient } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';

const FAKE_MODELS_DEV = {
  anthropic: {
    id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-3-7-sonnet-20250219': {
        id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet',
        attachment: false, reasoning: true, temperature: true, tool_call: true,
        reasoning_options: [{ type: 'budget_tokens' }],
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 8192 },
        status: 'beta',
      },
    },
  },
  openai: {
    id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: true, reasoning: false, temperature: true, tool_call: true,
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sync-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('fetchSync upserts providers, models, model_providers, pricing from models.dev', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => FAKE_MODELS_DEV,
    text: async () => JSON.stringify(FAKE_MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    const db = getDb();
    const providers = db.prepare('SELECT id FROM providers ORDER BY id').all() as { id: string }[];
    assert.deepEqual(providers.map(p => p.id), ['anthropic', 'openai']);
    const models = db.prepare('SELECT id, name, reasoning, tool_call, context_limit FROM models ORDER BY id').all() as Array<{ id: string; name: string; reasoning: number; tool_call: number; context_limit: number }>;
    assert.equal(models.length, 2);
    const claude = models.find(m => m.id.startsWith('anthropic/'))!;
    assert.equal(claude.name, 'Claude 3.7 Sonnet');
    assert.equal(claude.reasoning, 1);
    assert.equal(claude.tool_call, 1);
    assert.equal(claude.context_limit, 200000);
    const pricing = db.prepare('SELECT model_id, input, output, cache_read, cache_write FROM pricing ORDER BY model_id').all() as Array<{ model_id: string; input: number; output: number; cache_read: number; cache_write: number }>;
    assert.equal(pricing.length, 2);
    const claudePricing = pricing.find(p => p.model_id.startsWith('anthropic/'))!;
    assert.equal(claudePricing.input, 3);
    assert.equal(claudePricing.output, 15);
    assert.equal(claudePricing.cache_read, 0.3);
    const cacheState = db.prepare('SELECT source, last_status, count FROM catalog_cache_state WHERE source = ?').get('models.dev') as { source: string; last_status: string; count: number };
    assert.equal(cacheState.last_status, 'ok');
    assert.equal(cacheState.count, 2);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync writes one pricing row per cost tier with correct values', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  const payload = {
    openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: true, reasoning: false, temperature: true, tool_call: true,
        cost: {
          input: 2.5, output: 10, cache_read: 1.25, cache_write: 5,
          tiers: [
            { input: 0.5, output: 1.5, cache_read: 0.25, cache_write: 0.75, tier: { type: 'input', size: 128000 } },
            { input: 0.4, output: 1.2, cache_read: 0.2, tier: { type: 'input', size: 200000 } },
          ],
        },
        limit: { context: 200000, output: 16384 },
      },
    } },
  };
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    const db = getDb();
    const rows = db.prepare(
      'SELECT model_id, tier_size, input, output, cache_read, cache_write FROM pricing WHERE model_id = ? ORDER BY tier_size',
    ).all('openai/gpt-4o') as Array<{ model_id: string; tier_size: number; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null }>;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => [r.tier_size, r.input, r.output, r.cache_read, r.cache_write]), [
      [0, 2.5, 10, 1.25, 5],
      [128000, 0.5, 1.5, 0.25, 0.75],
      [200000, 0.4, 1.2, 0.2, null],
    ]);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync does not duplicate pricing rows on repeated sync', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => FAKE_MODELS_DEV,
    text: async () => JSON.stringify(FAKE_MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const db = getDb();
    const pricing = db.prepare('SELECT model_id, tier_size FROM pricing ORDER BY model_id').all() as Array<{ model_id: string; tier_size: number }>;
    assert.equal(pricing.length, 2);
    for (const p of pricing) assert.equal(p.tier_size, 0);
    const models = db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number };
    assert.equal(models.c, 2);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync with fresh cache skips network unless force is set', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      status: 200, ok: true,
      json: async () => FAKE_MODELS_DEV,
      text: async () => JSON.stringify(FAKE_MODELS_DEV),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const now = new Date();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, count, next_refresh) VALUES (?, ?, ?, ?, ?)')
      .run('models.dev', now.toISOString(), 'ok', 2, new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString());

    const skipped = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json' });
    assert.equal(skipped.skipped, true);
    assert.equal(fetchCalls, 0);

    const forced = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(forced.skipped, undefined);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync records error status on fetch failure', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 500, ok: false, json: async () => ({}), text: async () => 'server error' } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    const cacheState = getDb().prepare('SELECT last_status, last_error FROM catalog_cache_state WHERE source = ?').get('models.dev') as { last_status: string; last_error: string };
    assert.equal(cacheState.last_status, 'error');
    assert.ok(cacheState.last_error);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync preserves user custom providers on id collision but updates synced rows', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  const model = (id: string) => ({
    id, name: id, attachment: false, reasoning: false, temperature: true, tool_call: true,
    cost: { input: 1, output: 2 }, limit: { context: 128000, output: 4096 },
  });
  const payload = {
    synth: { id: 'synth', name: 'Synth From Catalog', api: 'https://api.synth.example/v1', env: ['SYNTH_API_KEY'], models: { 'synth-1': model('synth-1') } },
    openai: { id: 'openai', name: 'OpenAI From Catalog', api: 'https://api.openai.example/v1', env: ['OPENAI_API_KEY'], models: { 'gpt-4o': model('gpt-4o') } },
  };
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response)) as typeof fetch;
  try {
    const seededAt = '2020-01-01T00:00:00.000Z';
    const db = getDb();
    db.prepare(
      'INSERT INTO providers (id, name, api_base, auth_scheme, env_var, is_builtin, adapter, header_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('synth', 'My Local Synth', 'https://my.local.example/v1', 'bearer', 'MY_SYNTH_KEY', 0, 'openai-compat', null, seededAt, seededAt);
    db.prepare(
      'INSERT INTO providers (id, name, api_base, auth_scheme, env_var, is_builtin, adapter, header_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('openai', 'OpenAI Stale', 'https://stale.openai.example/v1', 'bearer', 'OLD_OPENAI_KEY', 1, 'anthropic', null, seededAt, seededAt);

    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);

    const custom = db.prepare('SELECT name, api_base, env_var, adapter, is_builtin, updated_at FROM providers WHERE id = ?').get('synth');
    assert.deepEqual(custom, {
      name: 'My Local Synth', api_base: 'https://my.local.example/v1',
      env_var: 'MY_SYNTH_KEY', adapter: 'openai-compat', is_builtin: 0, updated_at: seededAt,
    });

    const synced = db.prepare('SELECT name, api_base, env_var, adapter, is_builtin FROM providers WHERE id = ?').get('openai');
    assert.deepEqual(synced, {
      name: 'OpenAI From Catalog', api_base: 'https://api.openai.example/v1',
      env_var: 'OPENAI_API_KEY', adapter: 'openai-compat', is_builtin: 1,
    });
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync persists provider api URL as api_base and drops unsafe URLs', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  const model = (id: string) => ({
    id, name: id, attachment: false, reasoning: false, temperature: true, tool_call: true,
    cost: { input: 1, output: 2 }, limit: { context: 128000, output: 4096 },
  });
  const payload = {
    synth: { id: 'synth', name: 'Synth', api: 'https://api.synth.example/v1', env: ['SYNTH_API_KEY'], models: { 'synth-1': model('synth-1') } },
    sneaky: { id: 'sneaky', name: 'Sneaky', api: 'http://169.254.169.254/latest/meta-data', env: ['SNEAKY_API_KEY'], models: { 'sneaky-1': model('sneaky-1') } },
  };
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);
    const rows = getDb().prepare('SELECT id, api_base FROM providers ORDER BY id').all() as Array<{ id: string; api_base: string | null }>;
    assert.deepEqual(rows, [
      { id: 'sneaky', api_base: null },
      { id: 'synth', api_base: 'https://api.synth.example/v1' },
    ]);

    payload.synth.api = 'https://api.synth-v2.example/v1';
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const updated = getDb().prepare('SELECT api_base FROM providers WHERE id = ?').get('synth') as { api_base: string };
    assert.equal(updated.api_base, 'https://api.synth-v2.example/v1');
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync batches catalog upserts into a single transaction', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  const manyModels: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) {
    manyModels[`model-${i}`] = {
      id: `model-${i}`, name: `Model ${i}`,
      attachment: false, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 1, output: 2 }, limit: { context: 128000, output: 4096 },
    };
  }
  const payload = {
    openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: manyModels },
  };
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response)) as typeof fetch;

  const db = getDrizzleClient() as unknown as {
    transaction: (...args: unknown[]) => unknown;
    insert: (...args: unknown[]) => unknown;
  };
  const origTransaction = db.transaction;
  const origInsert = db.insert;
  let transactionCalls = 0;
  let directInsertCalls = 0;
  db.transaction = (...args: unknown[]) => {
    transactionCalls++;
    return origTransaction.apply(db, args);
  };
  db.insert = (...args: unknown[]) => {
    directInsertCalls++;
    return origInsert.apply(db, args);
  };
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 12);
    assert.equal(transactionCalls, 1, 'all catalog upserts must run in one transaction');
    assert.ok(
      directInsertCalls < result.count,
      `per-model inserts must be batched, got ${directInsertCalls} direct inserts for ${result.count} models`,
    );
    const models = getDb().prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number };
    assert.equal(models.c, 12);
  } finally {
    db.transaction = origTransaction;
    db.insert = origInsert;
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync deduplicates duplicate cost tiers before batching', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  const payload = {
    openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: false, reasoning: false, temperature: true, tool_call: true,
        cost: {
          input: 2.5, output: 10,
          tiers: [
            { input: 1, output: 2, tier: { type: 'input', size: 128000 } },
            { input: 1.5, output: 2.5, tier: { type: 'input', size: 128000 } },
          ],
        },
        limit: { context: 200000, output: 16384 },
      },
    } },
  };
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true, `sync must survive duplicate tiers: ${result.error ?? ''}`);
    const rows = getDb().prepare(
      'SELECT tier_size, input, output FROM pricing WHERE model_id = ? ORDER BY tier_size',
    ).all('openai/gpt-4o') as Array<{ tier_size: number; input: number; output: number }>;
    assert.deepEqual(rows, [
      { tier_size: 0, input: 2.5, output: 10 },
      { tier_size: 128000, input: 1.5, output: 2.5 },
    ]);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync prunes pricing snapshots older than the retention window', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => FAKE_MODELS_DEV,
    text: async () => JSON.stringify(FAKE_MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    const oldVersion = '2020-01-01T00:00:00.000Z';
    getDb().prepare(
      'INSERT INTO pricing_snapshots (version, model_id, input, output, tier_size, snapshot_at) VALUES (?,?,?,?,?,?)',
    ).run(oldVersion, 'openai/gpt-4o', 1, 2, 0, oldVersion);

    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);

    const stale = getDb().prepare('SELECT COUNT(*) AS c FROM pricing_snapshots WHERE version = ?').get(oldVersion) as { c: number };
    assert.equal(stale.c, 0, 'snapshots older than the retention window must be pruned');
    const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = getDb().prepare('SELECT COUNT(*) AS c FROM pricing_snapshots WHERE snapshot_at >= ?').get(recentCutoff) as { c: number };
    assert.ok(fresh.c >= 2, `expected fresh snapshots for both models, got ${fresh.c}`);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});
