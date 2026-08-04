import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJudgeScore } from '../../src/anomaly-detection/detectors.js';

test('readJudgeScore reads averageScore from judge_score.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-judge-'));
  fs.writeFileSync(path.join(dir, 'judge_score.json'), JSON.stringify({ averageScore: 88.5, scores: [], summary: '', judgedAt: '', judgeModel: 'x', model: 'm', runId: 'r' }));
  assert.equal(readJudgeScore(dir), 88.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJudgeScore returns null when file missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-judge-miss-'));
  assert.equal(readJudgeScore(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
