import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postWithRetry } from '../../src/notifications/retry.js';

/**
 * Outbox send-path timeout contract: every fetch attempt must be bounded by
 * an abort signal so a blackholed endpoint cannot occupy a delivery slot for
 * minutes and outlive the outbox claim lease (duplicate-delivery risk).
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('postWithRetry passes a live abort signal to every fetch attempt', async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const redirects: Array<RequestInit['redirect']> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    redirects.push(init?.redirect);
    return new Response('boom', { status: 500 });
  }) as typeof fetch;

  const res = await postWithRetry('https://hooks.example.test/slack', '{"a":1}');

  assert.equal(res.status, 500);
  assert.equal(signals.length, 3, 'initial attempt + 2 retries');
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, 'each attempt must receive an AbortSignal');
    assert.equal(signal.aborted, false, 'the signal must be live when the attempt starts');
  }
  assert.equal(new Set(signals).size, 3, 'each attempt must get a fresh signal, not a spent one');
  for (const redirect of redirects) {
    assert.equal(redirect, 'error', 'redirects must not be followed (SSRF gate bypass)');
  }
});
