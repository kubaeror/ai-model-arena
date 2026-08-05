import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../../src/dashboard-server/secrets.js';

test('maskSecrets masks exactly-named sensitive keys', () => {
  const out = maskSecrets({ api_key: 'x', password: 'y', token: 'z', authorization: 'Bearer abc' }) as Record<string, unknown>;
  assert.equal(out.api_key, '***');
  assert.equal(out.password, '***');
  assert.equal(out.token, '***');
  assert.equal(out.authorization, '***');
});

test('maskSecrets does NOT mask compound field names', () => {
  const out = maskSecrets({ tokenUsage: 123, tokenCount: 4, spent: '$1', credentialRef: 'none' }) as Record<string, unknown>;
  assert.equal(out.tokenUsage, 123);
  assert.equal(out.tokenCount, 4);
  assert.equal(out.credentialRef, 'none');
});

test('maskSecrets recurse deep', () => {
  assert.equal((maskSecrets({ nested: { apiKey: 's' } }) as any).nested.apiKey, '***');
});
