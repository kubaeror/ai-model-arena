import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRole } from '../../src/auth/rbac.js';

test('requireRole blocks viewer from editor routes', () => {
  const middleware = requireRole('editor');
  let status = 0;
  const req = { user: { role: 'viewer' } };
  const res = { status: (s: number) => ({ json: () => { status = s; } }) };
  middleware(req as any, res as any, () => {});
  assert.equal(status, 403);
});

test('requireRole allows admin through viewer routes', () => {
  const middleware = requireRole('viewer');
  let called = false;
  const req = { user: { role: 'admin' } };
  const res = { status: () => ({ json: () => {} }) };
  middleware(req as any, res as any, () => { called = true; });
  assert.ok(called);
});
