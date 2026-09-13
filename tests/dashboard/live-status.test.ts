import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectLiveRuns } from '../../src/dashboard-server/live.js';
import { shouldAttemptFinalize } from '../../src/orchestrator/orchestrator.js';
import { FINALIZE_STALE_MS } from '../../src/orchestrator/finalize/aggregate.js';
import type { RunIndexRecord } from '../../src/orchestrator/run-index.js';

function runRecord(status: RunIndexRecord['status'], finishedAt: string | null): RunIndexRecord {
  return {
    runId: `run-${status}`,
    scenario: 'basic',
    models: ['gpt-4o'],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt,
    status,
    source: 'dashboard',
    perModel: [],
    comparisonMdPath: null,
    comparisonJsonPath: null,
  };
}

test('finalizing runs stay in the live status list until completed', () => {
  const live = selectLiveRuns([
    runRecord('running', null),
    runRecord('finalizing', new Date().toISOString()),
    runRecord('completed', new Date().toISOString()),
  ]);
  assert.deepEqual(live.map((r) => r.status), ['running', 'finalizing']);
});

test('the watcher retries only stale finalizing runs', () => {
  const now = Date.parse('2026-01-01T00:10:00.000Z');
  const fresh = { status: 'finalizing', finishedAt: new Date(now - FINALIZE_STALE_MS + 5000).toISOString() };
  const stale = { status: 'finalizing', finishedAt: new Date(now - FINALIZE_STALE_MS - 1).toISOString() };
  assert.equal(shouldAttemptFinalize(fresh, now), false, 'an active finalizer must not be raced');
  assert.equal(shouldAttemptFinalize(stale, now), true, 'a crashed finalizer is retried');
  assert.equal(shouldAttemptFinalize({ status: 'running', finishedAt: null }, now), true);
  assert.equal(shouldAttemptFinalize({ status: 'stopped', finishedAt: null }, now), true);
  assert.equal(shouldAttemptFinalize({ status: 'completed', finishedAt: null }, now), false);
  assert.equal(shouldAttemptFinalize({ status: 'finalizing', finishedAt: null }, now), true, 'a missing claim timestamp is recoverable');
});
