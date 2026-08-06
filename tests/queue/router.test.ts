import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamKey, dlqStreamKey, knownProviders, familyFor } from '../../src/queue/router.js';
import { BUILTIN_PROVIDERS } from '../../src/providers/index.js';

test('streamKey routes openai to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'openai'), 'arena:tasks:openai-compat');
});

test('streamKey routes groq to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'groq'), 'arena:tasks:openai-compat');
});

test('streamKey routes cerebras to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'cerebras'), 'arena:tasks:openai-compat');
});

test('streamKey routes anthropic as-is (no remapped family)', () => {
  assert.equal(streamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic');
});

test('streamKey routes google as-is', () => {
  assert.equal(streamKey('arena:tasks', 'google'), 'arena:tasks:google');
});

test('streamKey falls through for unknown provider', () => {
  assert.equal(streamKey('prefix', 'unknown-provider'), 'prefix:unknown-provider');
});

test('dlqStreamKey suffixes with :dlq', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'openai'), 'arena:tasks:openai-compat:dlq');
});

test('dlqStreamKey for anthropic', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic:dlq');
});

test('dlqStreamKey falls through for unknown provider', () => {
  assert.equal(dlqStreamKey('prefix', 'unknown-provider'), 'prefix:unknown-provider:dlq');
});

test('known adapter families map to shared streams', () => {
  assert.equal(streamKey('arena:tasks', 'deepseek'), 'arena:tasks:openai-compat');
  assert.equal(streamKey('arena:tasks', 'together'), 'arena:tasks:openai-compat');
  assert.equal(streamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic');
  assert.equal(streamKey('arena:tasks', 'google'), 'arena:tasks:google');
});

test('bedrock routes to its own stream (IAM auth, no shared family)', () => {
  assert.equal(streamKey('arena:tasks', 'bedrock'), 'arena:tasks:bedrock');
});

test('unknown/custom providers keep per-provider streams', () => {
  assert.equal(streamKey('arena:tasks', 'my-custom'), 'arena:tasks:my-custom');
  assert.equal(familyFor('my-custom'), 'my-custom');
});

test('every builtin provider resolves to a family', () => {
  for (const d of BUILTIN_PROVIDERS) {
    const family = familyFor(d.id);
    assert.ok(family.length > 0, `family for ${d.id}`);
  }
});

test('knownProviders covers all builtin providers', () => {
  const ids = new Set(BUILTIN_PROVIDERS.map((d) => d.id));
  for (const id of knownProviders) assert.ok(ids.has(id), `known: ${id}`);
  for (const id of ids) assert.ok(knownProviders.includes(id), `missing: ${id}`);
});

test('dlq mirrors stream key', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'deepseek'), 'arena:tasks:openai-compat:dlq');
});
