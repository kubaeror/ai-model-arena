import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRole, apiKeyImpliedRole, apiKeyIsAdmin } from '../../src/auth/rbac.js';

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

test('apiKeyImpliedRole maps write permissions to role floors', () => {
  assert.equal(apiKeyImpliedRole({ permissions: ['models:read'] }), 'viewer');
  assert.equal(apiKeyImpliedRole({ permissions: ['runs:write'] }), 'editor');
  assert.equal(apiKeyImpliedRole({ permissions: ['users:write'] }), 'admin');
  assert.equal(apiKeyImpliedRole({ permissions: ['runs:write', 'users:write'] }), 'admin');
  assert.equal(apiKeyImpliedRole(undefined), undefined);
});

test('apiKeyIsAdmin requires ops:admin', () => {
  assert.equal(apiKeyIsAdmin({ apiKey: { permissions: ['ops:admin'] } }), true);
  assert.equal(apiKeyIsAdmin({ apiKey: { permissions: ['users:write'] } }), false);
  assert.equal(apiKeyIsAdmin({}), false);
});

test('requireRole lets an API key with editor-level permissions through editor gates', () => {
  const middleware = requireRole('editor');
  let called = false;
  const req = { apiKey: { permissions: ['runs:write'] } };
  const res = { status: () => ({ json: () => {} }) };
  middleware(req as any, res as any, () => { called = true; });
  assert.ok(called);
});

test('requireRole denies API keys below the role floor', () => {
  const middleware = requireRole('admin');
  let status = 0;
  const req = { apiKey: { permissions: ['runs:write'] } };
  const res = { status: (s: number) => ({ json: () => { status = s; } }) };
  middleware(req as any, res as any, () => {});
  assert.equal(status, 403);
});
