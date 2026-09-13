import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { loadBuiltins } from '../../src/providers/index.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { getDrizzleDb } from '../../src/db/index.js';
import { providers, models } from '../../src/db/schema.js';
import { OpenAICompatAdapter } from '../../src/providers/adapters/openai-compat.js';

interface SeedProvider {
  id: string;
  name: string;
  apiBase?: string | null;
  authScheme?: 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';
  envVar?: string | null;
  isBuiltin?: number;
  adapter?: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
}

async function seedProvider(row: SeedProvider): Promise<void> {
  const now = new Date().toISOString();
  await getDrizzleDb().insert(providers).values({
    id: row.id, name: row.name, api_base: row.apiBase ?? null,
    auth_scheme: row.authScheme ?? 'bearer', env_var: row.envVar ?? null,
    is_builtin: row.isBuiltin ?? 1, adapter: row.adapter ?? 'openai-compat',
    header_name: null, created_at: now, updated_at: now,
  });
}

test('ProviderRegistry lists built-in providers after loadBuiltins', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  const ids = reg.list().map(p => p.id);
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('google'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('groq'));
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.length >= 10, `expected >= 10, got ${ids.length}`);
});

test('ProviderRegistry.get returns descriptor by id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  const oai = reg.get('openai');
  assert.ok(oai);
  assert.equal(oai!.adapter, 'openai-compat');
  assert.equal(oai!.authScheme, 'bearer');
  assert.equal(oai!.envVar, 'OPENAI_API_KEY');
});

test('ProviderRegistry.get returns undefined for unknown id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  assert.equal(reg.get('does-not-exist'), undefined);
});

test('ProviderRegistry.register overrides existing id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  reg.register({ id: 'openai', name: 'Custom', adapter: 'openai-compat', authScheme: 'bearer', isBuiltin: false });
  assert.equal(reg.get('openai')!.name, 'Custom');
  assert.equal(reg.get('openai')!.isBuiltin, false);
});

test('catalog-synced provider rows (is_builtin=1) resolve to a working adapter', async () => {
  initDb(':memory:');
  try {
    await seedProvider({ id: 'synth', name: 'Synth', apiBase: 'https://api.synth.example/v1', envVar: 'SYNTH_API_KEY' });
    const now = new Date().toISOString();
    await getDrizzleDb().insert(models).values({
      id: 'synth/synth-1', name: 'Synth 1', family: null, provider_id: 'synth',
      release_date: null, attachment: 0, reasoning: 0, temperature: 1, tool_call: 1,
      interleaved: null, status: 'active', context_limit: 128000, input_limit: null,
      output_limit: 4096, modalities: null, reasoning_options: null,
      source_json: null, last_synced_at: now,
    });

    const origFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const reg = new ProviderRegistry();
      loadBuiltins(reg);
      await reg.loadCustomFromDb();

      const adapter = reg.createAdapter('synth', 'synth-1', { apiKey: 'test-key' });
      assert.ok(adapter instanceof OpenAICompatAdapter);
      const response = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
      assert.equal(requestedUrl, 'https://api.synth.example/v1/chat/completions');
      assert.equal(response.text, 'hello');
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    closeDb();
  }
});

test('static builtin descriptors win over conflicting DB rows', async () => {
  initDb(':memory:');
  try {
    await seedProvider({
      id: 'openai', name: 'Shadow OpenAI', apiBase: 'https://shadow.example/v1',
      envVar: 'SHADOW_OPENAI_KEY', isBuiltin: 0,
    });
    await seedProvider({
      id: 'anthropic', name: 'Shadow Anthropic', isBuiltin: 1, adapter: 'openai-compat',
    });

    const reg = new ProviderRegistry();
    loadBuiltins(reg);
    await reg.loadCustomFromDb();

    const openai = reg.get('openai')!;
    assert.equal(openai.name, 'OpenAI');
    assert.equal(openai.apiBase, 'https://api.openai.com/v1');
    assert.equal(openai.envVar, 'OPENAI_API_KEY');
    assert.equal(openai.isBuiltin, true);

    const anthropic = reg.get('anthropic')!;
    assert.equal(anthropic.name, 'Anthropic');
    assert.equal(anthropic.adapter, 'anthropic');
    assert.equal(anthropic.envVar, 'ANTHROPIC_API_KEY');
  } finally {
    closeDb();
  }
});

test('createAdapter rejects DB provider URLs that fail validation', async () => {
  initDb(':memory:');
  try {
    await seedProvider({ id: 'meta-probe', name: 'Meta Probe', apiBase: 'https://169.254.169.254/v1' });
    await seedProvider({ id: 'plain-http', name: 'Plain HTTP', apiBase: 'http://api.example.com/v1' });

    const reg = new ProviderRegistry();
    loadBuiltins(reg);
    await reg.loadCustomFromDb();

    assert.throws(() => reg.createAdapter('meta-probe', 'm', {}), /failed re-validation/);
    assert.throws(() => reg.createAdapter('plain-http', 'm', {}), /failed re-validation/);
  } finally {
    closeDb();
  }
});

test('user-created custom provider rows (is_builtin=0) still resolve', async () => {
  initDb(':memory:');
  try {
    await seedProvider({
      id: 'my-endpoint', name: 'My Endpoint', apiBase: 'https://api.mine.example/v1',
      envVar: 'MY_KEY', isBuiltin: 0, adapter: 'anthropic',
    });

    const reg = new ProviderRegistry();
    loadBuiltins(reg);
    await reg.loadCustomFromDb();

    assert.equal(reg.get('my-endpoint')!.adapter, 'anthropic');
    assert.equal(reg.get('my-endpoint')!.apiBase, 'https://api.mine.example/v1');
  } finally {
    closeDb();
  }
});
