import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { loadBuiltins } from '../../src/providers/index.js';

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
