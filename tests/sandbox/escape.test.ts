import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeResolve, isWithin } from '../../src/sandbox/sandbox.js';

test('rejects .. traversal', () => {
  assert.throws(() => safeResolve('/sandbox', '../../etc/passwd'));
});

test('rejects absolute path outside sandbox', () => {
  assert.throws(() => safeResolve('/sandbox', '/etc/passwd'));
});

test('allows absolute path inside sandbox', () => {
  const p = safeResolve('/sandbox', '/sandbox/sub/file.txt');
  assert.ok(p.includes('sub'));
});

test('rejects drive-relative path', () => {
  assert.throws(() => safeResolve('/sandbox', 'C:foo'));
});

test('isWithin true for descendant', () => {
  assert.equal(isWithin('/sandbox', '/sandbox/a/b'), true);
});

test('isWithin false for sibling', () => {
  assert.equal(isWithin('/sandbox', '/other'), false);
});

test('isWithin false for parent', () => {
  assert.equal(isWithin('/sandbox/a', '/sandbox'), false);
});
