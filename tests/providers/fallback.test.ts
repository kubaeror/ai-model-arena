import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFallback, type FallbackConfig } from '../../src/providers/fallback.js';

test('resolves next in chain', () => {
  const chain: FallbackConfig = {
    primary: { provider: 'openai', model: 'gpt-4o' },
    fallbacks: [{ provider: 'anthropic', model: 'claude' }],
  };
  const next = resolveFallback({ provider: 'openai', model: 'gpt-4o' }, chain);
  assert.equal(next?.provider, 'anthropic');
  assert.equal(next?.model, 'claude');
});

test('returns null for last', () => {
  const chain: FallbackConfig = {
    primary: { provider: 'openai', model: 'gpt-4o' },
    fallbacks: [],
  };
  assert.equal(resolveFallback({ provider: 'openai', model: 'gpt-4o' }, chain), null);
});
