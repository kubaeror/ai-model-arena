import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boot, authedGet, TEST_ADMIN } from './route-test-harness.js';
import { upsertRun } from '../../src/db/runs.js';
import { insertJudgeScore } from '../../src/db/query.js';

test('GET /api/runs/:runId includes judge scores', async (t) => {
  const h = await boot(t);

  await upsertRun({
    runId: 'run-judge-1',
    scenario: 'scenario-a',
    models: ['gpt-4o'],
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    status: 'completed',
    source: 'cli',
    createdBy: TEST_ADMIN.username,
    perModel: [{
      model: 'gpt-4o',
      runId: 'run-judge-1',
      outputDir: path.join(h.tmpDir, 'out'),
      sandboxDir: path.join(h.tmpDir, 'sandbox'),
      resultPath: '/x/result.json',
      conversationPath: '/x/conv.json',
      reportPath: '/x/report.md',
      logFile: '/x/run.log',
      status: 'completed',
    }],
  });
  await insertJudgeScore({
    runId: 'run-judge-1',
    model: 'gpt-4o',
    judgeModel: 'gpt-4o-judge',
    averageScore: 87.5,
    summary: 'Clean implementation with passing tests',
    scoresJson: JSON.stringify({ completeness: 90, correctness: 85 }),
    judgedAt: '2026-01-01T00:06:00.000Z',
  });

  const res = await authedGet(h.base, h.adminToken, '/api/runs/run-judge-1');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    run: { runId: string };
    judge: Array<{ model: string; judge_model: string; average_score: number; summary: string }>;
  };
  assert.equal(body.run.runId, 'run-judge-1');
  assert.ok(Array.isArray(body.judge), 'response includes a judge array');
  assert.equal(body.judge.length, 1);
  assert.equal(body.judge[0]?.model, 'gpt-4o');
  assert.equal(body.judge[0]?.judge_model, 'gpt-4o-judge');
  assert.equal(body.judge[0]?.average_score, 87.5);
});

test('GET /api/runs/:runId returns empty judge array when no scores exist', async (t) => {
  const h = await boot(t);

  await upsertRun({
    runId: 'run-no-judge',
    scenario: 'scenario-a',
    models: ['gpt-4o'],
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: '2026-01-02T00:05:00.000Z',
    status: 'completed',
    source: 'cli',
    createdBy: TEST_ADMIN.username,
    perModel: [{
      model: 'gpt-4o',
      runId: 'run-no-judge',
      outputDir: path.join(h.tmpDir, 'out'),
      sandboxDir: path.join(h.tmpDir, 'sandbox'),
      resultPath: '/x/result.json',
      conversationPath: '/x/conv.json',
      reportPath: '/x/report.md',
      logFile: '/x/run.log',
      status: 'completed',
    }],
  });

  const res = await authedGet(h.base, h.adminToken, '/api/runs/run-no-judge');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { judge: unknown[] };
  assert.ok(Array.isArray(body.judge), 'response includes a judge array');
  assert.equal(body.judge.length, 0);
});
