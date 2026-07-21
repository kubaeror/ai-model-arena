import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheMetrics } from '../../src/metrics/cache-metrics.js';

test('extractCacheMetrics: all zero for empty usage', () => {
  const result = extractCacheMetrics({ prompt: 0, completion: 0 });
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
  assert.equal(result.cacheHitRate, 0);
});

test('extractCacheMetrics: computes hit rate correctly', () => {
  const result = extractCacheMetrics({ prompt: 100, completion: 50, cacheReadTokens: 60, cacheWriteTokens: 10 });
  assert.equal(result.cacheReadTokens, 60);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.cacheHitRate, 0.6);
});

test('extractCacheMetrics: returns 0 hit rate when prompt is 0', () => {
  const result = extractCacheMetrics({ prompt: 0, completion: 50, cacheReadTokens: 100, cacheWriteTokens: 0 });
  assert.equal(result.cacheHitRate, 0);
});

test('extractCacheMetrics: defaults missing cache fields to 0', () => {
  const result = extractCacheMetrics({ prompt: 100, completion: 50 });
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheWriteTokens, 0);
  assert.equal(result.cacheHitRate, 0);
});
