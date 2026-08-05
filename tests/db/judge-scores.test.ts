import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { insertJudgeScore, listJudgeScores } from '../../src/db/query.js';

test('insertJudgeScore upserts: second verdict for same run+model updates the row', async () => {
  initDb(':memory:');

  await insertJudgeScore({
    runId: 'run-1', model: 'gpt-4o', judgeModel: 'gpt-4o',
    averageScore: 55, summary: 'first verdict', scoresJson: '[]',
    judgedAt: '2026-01-01T00:00:00.000Z',
  });
  await insertJudgeScore({
    runId: 'run-1', model: 'gpt-4o', judgeModel: 'claude-3.7',
    averageScore: 88, summary: 'second verdict', scoresJson: '[{"category":"correctness","score":9}]',
    judgedAt: '2026-01-02T00:00:00.000Z',
  });

  const rows = await listJudgeScores('run-1');
  assert.equal(rows.length, 1, 're-judging the same run+model must not duplicate the row');
  assert.equal(rows[0]!.model, 'gpt-4o');
  assert.equal(rows[0]!.judge_model, 'claude-3.7');
  assert.equal(rows[0]!.average_score, 88);
  assert.equal(rows[0]!.summary, 'second verdict');
  assert.equal(rows[0]!.scores_json.includes('correctness'), true);
  assert.equal(rows[0]!.judged_at, '2026-01-02T00:00:00.000Z');

  closeDb();
});

test('insertJudgeScore keeps distinct rows for distinct runs or models', async () => {
  initDb(':memory:');
  const base = {
    judgeModel: 'gpt-4o', averageScore: 70, summary: 's', scoresJson: '[]',
    judgedAt: '2026-01-01T00:00:00.000Z',
  };
  await insertJudgeScore({ ...base, runId: 'run-1', model: 'gpt-4o' });
  await insertJudgeScore({ ...base, runId: 'run-2', model: 'gpt-4o' });
  await insertJudgeScore({ ...base, runId: 'run-1', model: 'claude-3.7' });

  const rows = await listJudgeScores();
  assert.equal(rows.length, 3);
  closeDb();
});
