import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../../src/providers/circuit-breaker.js';

test('opens after threshold consecutive failures', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.exec(async () => { throw new Error('boom'); }));
  }
  await assert.rejects(() => cb.exec(async () => 'ok'), CircuitOpenError);
});

test('half-open after reset timeout, closes on success', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
  await assert.rejects(() => cb.exec(async () => { throw new Error('x'); }));
  await new Promise(r => setTimeout(r, 60));
  const r = await cb.exec(async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(cb.state, 'closed');
});

test('isolated per provider, model', () => {
  const a = CircuitBreaker.for('openai', 'gpt-4o');
  const b = CircuitBreaker.for('anthropic', 'claude');
  assert.notEqual(a, b);
});
