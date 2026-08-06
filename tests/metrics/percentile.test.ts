import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile } from '../../src/metrics/percentile.js';
import { aggregateLatency } from '../../src/metrics/runtime.js';

function span(durationMs: number): { name: string; startedAt: number; endedAt: number } {
  return { name: 'chat', startedAt: 0, endedAt: durationMs };
}

const DURATIONS = Array.from({ length: 20 }, (_, i) => 10 + i); // [10..29]

test('percentile uses nearest-rank on sorted data', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);   // ceil(0.5*4)-1 = 1 → 2
  assert.equal(percentile([1, 2, 3, 4], 95), 4);   // ceil(0.95*4)-1 = 3 → 4
  assert.equal(percentile([1, 2, 3], 50), 2);      // ceil(0.5*3)-1 = 1 → 2
  assert.equal(percentile([], 50), undefined);     // empty input
});

test('aggregateLatency p50/p95 match the shared nearest-rank percentile', () => {
  const result = aggregateLatency(DURATIONS.map((d) => span(d)));
  assert.equal(result.p50, percentile(DURATIONS, 50)); // ceil(10)-1 = 9 → 19
  assert.equal(result.p95, percentile(DURATIONS, 95)); // ceil(19)-1 = 18 → 28
});

test('aggregateLatency returns nulls for empty input and honors filterName', () => {
  assert.deepEqual(aggregateLatency([]), { p50: null, p95: null });
  const mixed = [{ name: 'other', startedAt: 0, endedAt: 500 }, ...DURATIONS.map((d) => span(d))];
  const filtered = aggregateLatency(mixed, 'chat');
  assert.equal(filtered.p50, percentile(DURATIONS, 50));
  assert.equal(filtered.p95, percentile(DURATIONS, 95));
});
