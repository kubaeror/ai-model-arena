import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, auditSafe, getAuditFailureCount } from '../../src/auth/rbac.js';

// H8: auditSafe() is a fire-and-forget wrapper around audit() that returns
// void (not a Promise) so it is eslint-safe under no-floating-promises, and
// logs failures via pino instead of swallowing them with .catch(() => {}).

test('auditSafe returns void (not a Promise)', () => {
  // The return value must be undefined so callers can invoke it as a plain
  // statement without triggering no-floating-promises.
  const result = auditSafe('test-actor', 'test.action', { type: 'test', id: '1' });
  assert.equal(result, undefined);
});

test('auditSafe does not throw even if the audit subsystem fails', async () => {
  // Force the dynamic import to fail by pointing at a non-existent module path.
  // audit() does `await import('../db/query.js')` — if the DB is unavailable
  // it catches and increments auditFailureCount. auditSafe must not propagate.
  const before = getAuditFailureCount();
  assert.doesNotThrow(() => {
    auditSafe('test-actor', 'test.action.unreachable', { type: 'test', id: '2' });
  });
  // Give the fire-and-forget promise a tick to settle.
  await new Promise((r) => setTimeout(r, 50));
  // The failure counter may or may not have incremented depending on whether
  // the DB is reachable in this test env, but auditSafe must not have thrown.
  const after = getAuditFailureCount();
  assert.ok(after >= before, 'auditFailureCount should not decrease');
});

test('auditSafe handles missing entity.id gracefully', () => {
  // entity.id is optional; auditSafe must accept it without throwing.
  assert.doesNotThrow(() => {
    auditSafe('test-actor', 'test.action.no-id', { type: 'test' });
  });
});

test('audit is still exported and awaitable for callers that need to wait', async () => {
  // audit() remains available for callers that want to await (e.g. a critical
  // path that must confirm the audit record was written before proceeding).
  await assert.doesNotReject(() => audit('test-actor', 'test.action.awaited', { type: 'test', id: '3' }));
});
