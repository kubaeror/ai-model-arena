import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvaluationConfig, clampScore } from '../../src/evaluation/judge.js';

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-config-'));
  tmpDirs.push(dir);
  return dir;
}

test('loadEvaluationConfig re-reads file on each call (no stale cache)', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'evaluation.yaml');

  fs.writeFileSync(configPath, 'judge:\n  enabled: true\n  model: gpt-4o\n', 'utf8');
  const first = loadEvaluationConfig(configPath);
  assert.equal(first.judge?.enabled, true);
  assert.equal(first.judge?.model, 'gpt-4o');

  fs.writeFileSync(configPath, 'judge:\n  enabled: false\n  model: gpt-4o\n', 'utf8');
  const second = loadEvaluationConfig(configPath);
  assert.equal(second.judge?.enabled, false);
});

test('loadEvaluationConfig returns default config and warns when file missing', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'missing-evaluation.yaml');
  let warned = 0;
  const logger = { warn: () => { warned++; } } as unknown as Parameters<typeof loadEvaluationConfig>[1];
  const config = loadEvaluationConfig(configPath, logger);
  assert.ok(config.judge === undefined);
  assert.ok(config.rubric === undefined);
  assert.ok(config.regression === undefined);
  assert.equal(warned, 1);
});

test('clampScore clamps numeric scores to [0, 100]', () => {
  assert.equal(clampScore(105), 100);
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(0), 0);
  assert.equal(clampScore(100), 100);
  assert.equal(clampScore(83.5), 83.5);
});
