import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from '../../src/auth/timing-safe.js';

test('timingSafeEqual returns true for identical strings', () => {
  assert.equal(timingSafeEqual('secret-api-key', 'secret-api-key'), true);
});

test('timingSafeEqual returns false for differing strings of equal length', () => {
  assert.equal(timingSafeEqual('secret-api-key', 'secret-api-kez'), false);
});

test('timingSafeEqual returns false for strings of differing length', () => {
  // The pre-hash makes this safe: crypto.timingSafeEqual itself would throw
  // on unequal buffer lengths, so the pre-hash is required for correctness.
  assert.equal(timingSafeEqual('short', 'a-much-longer-string'), false);
});

test('timingSafeEqual handles empty strings', () => {
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual('', 'x'), false);
});

test('timingSafeEqual handles unicode strings', () => {
  assert.equal(timingSafeEqual('pässwörd-日本語', 'pässwörd-日本語'), true);
  assert.equal(timingSafeEqual('pässwörd-日本語', 'password-japanese'), false);
});
