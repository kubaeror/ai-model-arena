import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireOwnership } from '../../src/auth/rbac.js';

// H2: requireOwnership must default-DENY when the resource has no owner
// (legacy/migrated). Previously it returned next() ("allow") when getOwnerId
// returned undefined, letting any authenticated viewer read/mutate another
// tenant's resources when createdBy was null.

interface MockUser {
  sub: string;
  role: string;
}

function runMiddleware(
  ownerId: string | undefined,
  user: MockUser | undefined,
): { statusCode: number; calledNext: boolean } {
  const state = { statusCode: 0, calledNext: false };
  const req: unknown = {
    headers: { 'x-test-owner-id': ownerId },
    user,
  };
  const res: unknown = {
    status(code: number) { state.statusCode = code; return this; },
    json() { return this; },
  };
  const middleware = requireOwnership((r: unknown) => {
    const headers = (r as { headers: Record<string, string | undefined> }).headers;
    const v = headers['x-test-owner-id'];
    // Treat empty string as undefined (defensive: an empty-string owner
    // should not be treated as a present owner).
    return v === '' ? undefined : v;
  });
  middleware(req as never, res as never, (() => { state.calledNext = true; }) as never);
  return { statusCode: state.statusCode, calledNext: state.calledNext };
}

test('requireOwnership allows the owner', () => {
  const r = runMiddleware('alice', { sub: 'alice', role: 'viewer' });
  assert.equal(r.calledNext, true);
  assert.equal(r.statusCode, 0);
});

test('requireOwnership allows an admin even when not the owner', () => {
  const r = runMiddleware('alice', { sub: 'bob', role: 'admin' });
  assert.equal(r.calledNext, true);
  assert.equal(r.statusCode, 0);
});

test('requireOwnership denies a non-owner non-admin', () => {
  const r = runMiddleware('alice', { sub: 'bob', role: 'viewer' });
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 403);
});

test('requireOwnership DEFAULT-DENIES when owner is undefined (legacy/migrated)', () => {
  // H2: previously this called next() ("allow") — now it must deny non-admins.
  const r = runMiddleware(undefined, { sub: 'bob', role: 'viewer' });
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 403);
});

test('requireOwnership allows an admin when owner is undefined (orphan reassignment)', () => {
  const r = runMiddleware(undefined, { sub: 'admin', role: 'admin' });
  assert.equal(r.calledNext, true);
  assert.equal(r.statusCode, 0);
});

test('requireOwnership denies a non-admin viewer when owner is null', () => {
  // null owner (DB returns null) — treated as undefined → deny non-admins.
  const r = runMiddleware(null as unknown as undefined, { sub: 'bob', role: 'viewer' });
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 403);
});

test('requireOwnership denies an empty-string owner for a non-owner actor', () => {
  // Defensive: empty-string owner is treated as undefined.
  const r = runMiddleware('', { sub: 'bob', role: 'viewer' });
  assert.equal(r.calledNext, false);
  assert.equal(r.statusCode, 403);
});
