import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken } from '../../src/dashboard-server/auth.js';

test('extractBearerToken parses a standard Bearer header', () => {
  assert.equal(extractBearerToken('Bearer eyJhbGciOiJIUzI1NiJ9'), 'eyJhbGciOiJIUzI1NiJ9');
});

test('extractBearerToken is case-insensitive on the scheme', () => {
  assert.equal(extractBearerToken('bearer token-abc'), 'token-abc');
  assert.equal(extractBearerToken('BEARER token-abc'), 'token-abc');
});

test('extractBearerToken tolerates spaces between scheme and token', () => {
  assert.equal(extractBearerToken('Bearer   token-abc'), 'token-abc');
});

test('extractBearerToken returns null for missing or malformed headers', () => {
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer '), null);
  assert.equal(extractBearerToken('Bearer   '), null);
});

test('extractBearerToken handles very long whitespace runs without pathological slowdown', () => {
  const spaces = ' '.repeat(100_000);
  const start = Date.now();
  const result = extractBearerToken(`Bearer ${spaces}`);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 5_000, `expected linear-time parse, took ${elapsed}ms`);
});
