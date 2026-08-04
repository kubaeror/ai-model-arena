import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFallback, resolveMaxFallbackHops, type FallbackConfig } from '../../src/providers/fallback.js';

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

test('max fallback hops defaults to 3 on missing/empty/unparseable env', () => {
  assert.equal(resolveMaxFallbackHops(undefined), 3);
  assert.equal(resolveMaxFallbackHops(''), 3);
  assert.equal(resolveMaxFallbackHops('abc'), 3);
});

test('max fallback hops parses an integer env value', () => {
  assert.equal(resolveMaxFallbackHops('0'), 0);
  assert.equal(resolveMaxFallbackHops('5'), 5);
  assert.equal(resolveMaxFallbackHops('2.9'), 2);
});

test('max fallback hops clamps to the [0, 10] range', () => {
  assert.equal(resolveMaxFallbackHops('-3'), 0);
  assert.equal(resolveMaxFallbackHops('99'), 10);
  assert.equal(resolveMaxFallbackHops('11'), 10);
});
