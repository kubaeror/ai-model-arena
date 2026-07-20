import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { resolveModelForRun } from '../../src/db/model-resolver.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
    'claude-3-7-sonnet-20250219': { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', attachment: false, reasoning: true, temperature: true, tool_call: true, cost: { input: 3, output: 15 }, limit: { context: 200000, output: 8192 } },
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

test('resolveModelForRun finds model by friendly name in DB', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const resolved = resolveModelForRun('GPT-4o');
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
    assert.equal(resolveModelForRun('nonexistent-model'), null);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
