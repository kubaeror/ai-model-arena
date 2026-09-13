import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { resolveModelForRun } from '../../src/db/model-resolver.js';
import type { FetchInput } from '../helpers/fetch-types.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
    'o3': { id: 'o3', name: 'o3', attachment: false, reasoning: true, temperature: false, tool_call: true, cost: { input: 2, output: 8 }, limit: { context: 200000, output: 100000 } },
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
    'claude-3-7-sonnet-20250219': { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', attachment: false, reasoning: true, temperature: true, tool_call: true, cost: { input: 3, output: 15 }, limit: { context: 200000, output: 8192 } },
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

test('resolveModelForRun finds model by friendly name in DB', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const resolved = await resolveModelForRun('GPT-4o');
    assert.ok(resolved);
    assert.equal(resolved!.providerId, 'openai');
    assert.equal(resolved!.apiModelId, 'gpt-4o');
    assert.equal(resolved!.canonicalId, 'openai/gpt-4o');
    assert.equal(resolved!.envVar, 'OPENAI_API_KEY');
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveModelForRun returns null for unknown model', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(await resolveModelForRun('nonexistent-model'), null);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveModelForRun resolves a fallback API model id within its provider', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const resolved = await resolveModelForRun('claude-3-7-sonnet-20250219', 'anthropic');
    assert.ok(resolved, 'api_model_id must resolve when the provider is known');
    assert.equal(resolved!.canonicalId, 'anthropic/claude-3-7-sonnet-20250219');
    assert.equal(resolved!.apiModelId, 'claude-3-7-sonnet-20250219');
    // Same string under the wrong provider must not match another provider's row.
    assert.equal(await resolveModelForRun('claude-3-7-sonnet-20250219', 'openai'), null);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveModelForRun gates sampling capability fields from the catalog', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const reasoningOnly = await resolveModelForRun('o3', 'openai');
    assert.ok(reasoningOnly);
    assert.equal(reasoningOnly!.temperature, null, 'temperature-unsupported model must not advertise a temperature');
    assert.equal(reasoningOnly!.reasoningOnly, true);
    assert.equal(reasoningOnly!.maxTokens, 100000);

    const standard = await resolveModelForRun('gpt-4o', 'openai');
    assert.ok(standard);
    assert.equal(standard!.temperature, 0.2);
    assert.equal(standard!.reasoningOnly, false);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveModelForRun omits maxTokens when the catalog has no output limit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const db = getDb();
  db.prepare("INSERT INTO providers (id, name, api_base, auth_scheme, adapter, created_at, updated_at) VALUES ('custom', 'Custom', NULL, 'bearer', 'openai-compat', datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO models (id, name, provider_id, reasoning, temperature, tool_call, last_synced_at) VALUES ('custom/legacy-model', 'legacy-model', 'custom', 0, 1, 1, datetime('now'))").run();
  db.prepare("INSERT INTO model_providers (model_id, provider_id, api_model_id) VALUES ('custom/legacy-model', 'custom', 'legacy-model')").run();
  try {
    const resolved = await resolveModelForRun('legacy-model');
    assert.ok(resolved);
    assert.equal(resolved!.maxTokens, null, 'unknown output limit must stay null (omit), not default');
    assert.equal(resolved!.temperature, 0.2);
    assert.equal(resolved!.reasoningOnly, false);
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
