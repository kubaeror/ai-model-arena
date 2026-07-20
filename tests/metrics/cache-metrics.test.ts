import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheMetrics } from '../../src/metrics/cache-metrics.js';
import type { TokenUsage } from '../../src/types.js';

test('extractCacheMetrics returns zeros when usage has no cache fields', () => {
  const m = extractCacheMetrics({ prompt: 100, completion: 50, total: 150 });
  assert.equal(m.cacheReadTokens, 0);
  assert.equal(m.cacheWriteTokens, 0);
  assert.equal(m.cacheHitRate, 0);
});

test('extractCacheMetrics computes hit rate from prompt + cacheReadTokens', () => {
  const m = extractCacheMetrics({ prompt: 1000, completion: 50, total: 1050, cacheReadTokens: 800, cacheWriteTokens: 200 });
  assert.equal(m.cacheReadTokens, 800);
  assert.equal(m.cacheWriteTokens, 200);
  assert.equal(m.cacheHitRate, 0.8);
});

test('extractCacheMetrics handles zero prompt tokens without NaN', () => {
  const m = extractCacheMetrics({ prompt: 0, cacheReadTokens: 0 });
  assert.equal(m.cacheHitRate, 0);
  assert.ok(!Number.isNaN(m.cacheHitRate));
});
