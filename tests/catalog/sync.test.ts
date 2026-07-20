import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
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
