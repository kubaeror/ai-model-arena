import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../../src/providers/circuit-breaker.js';

test('exec succeeds on first call', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
  let called = 0;
  const result = await cb.exec(async () => { called++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(called, 1);
  assert.equal(cb.state, 'closed');
});

test('opens after threshold failures', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
  try { await cb.exec(async () => { throw new Error('fail'); }); } catch {}
  try { await cb.exec(async () => { throw new Error('fail'); }); } catch {}
  assert.equal(cb.state, 'open');
  // Third call should throw CircuitOpenError
  try {
    await cb.exec(async () => 'should not reach');
    assert.fail('Expected CircuitOpenError');
  } catch (err) {
    assert.ok(err instanceof CircuitOpenError);
  }
});

test('half-open closes on success', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
  try { await cb.exec(async () => { throw new Error('fail'); }); } catch {}
  assert.equal(cb.state, 'open');
  // Wait for reset timeout
  await new Promise(r => setTimeout(r, 30));
  // exec transition to halfOpen then closes on success
  const result = await cb.exec(async () => 'recovered');
  assert.equal(result, 'recovered');
  assert.equal(cb.state, 'closed');
});

test('half-open re-opens on failure', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
  try { await cb.exec(async () => { throw new Error('fail'); }); } catch {}
  await new Promise(r => setTimeout(r, 30));
  try { await cb.exec(async () => { throw new Error('fail again'); }); } catch {}
  assert.equal(cb.state, 'open');
});

test('CircuitBreaker.for isolates by provider/model', () => {
  CircuitBreaker.cleanup();
  const cb1 = CircuitBreaker.for('openai', 'gpt-4o');
  const cb2 = CircuitBreaker.for('anthropic', 'claude-3');
  assert.ok(cb1 !== cb2);
  // Same key returns same instance
  const cb1b = CircuitBreaker.for('openai', 'gpt-4o');
  assert.ok(cb1 === cb1b);
});
