import { test } from 'node:test';
import assert from 'node:assert/strict';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

process.env.CATALOG_REFRESH_DAYS = '7';

const { refreshIntervalDays, refreshIntervalMs } = await import('../../src/catalog/sync.js');
const { getRefreshIntervalMs: cronRefreshIntervalMs } = await import('../../src/catalog/cron.js');
const { getRefreshIntervalMs: benchmarksRefreshIntervalMs } = await import('../../src/catalog/benchmarks.js');

test('refreshIntervalDays reads CATALOG_REFRESH_DAYS from the environment', () => {
  assert.equal(refreshIntervalDays(), 7);
  assert.equal(refreshIntervalMs(), 7 * MS_PER_DAY);
});

test('cron refresh interval derives from the shared helper', () => {
  assert.equal(cronRefreshIntervalMs(), 7 * MS_PER_DAY);
});

test('benchmarks refresh interval derives from the shared helper', () => {
  assert.equal(benchmarksRefreshIntervalMs(), 7 * MS_PER_DAY);
});

test('refreshIntervalDays falls back to 30 for invalid env values', () => {
  const previous = process.env.CATALOG_REFRESH_DAYS;
  process.env.CATALOG_REFRESH_DAYS = 'not-a-number';
  try {
    assert.equal(refreshIntervalDays(), 30);
  } finally {
    process.env.CATALOG_REFRESH_DAYS = previous;
  }
});
