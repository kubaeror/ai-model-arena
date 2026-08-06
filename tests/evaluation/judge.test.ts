import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { extractJsonObject, computeAverageScore, runJudgeScoring, resolveJudgeApiKey } from '../../src/evaluation/judge.js';
import type { EvaluationConfig } from '../../src/evaluation/types.js';

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
  tmpDirs.push(dir);
  initDb(path.join(dir, 'test.db'));
  return dir;
}

function seedCatalog(): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO providers (id, name, api_base, auth_scheme, is_builtin, adapter, created_at, updated_at)
     VALUES ('openai', 'OpenAI', 'https://api.openai.com/v1', 'bearer', 1, 'openai-compat', ?, ?)`,
  ).run(now, now);
  getDb().prepare(
    `INSERT INTO models (id, name, provider_id, status, last_synced_at)
     VALUES ('gpt-4o', 'GPT-4o', 'openai', 'active', ?)`,
  ).run(now);
  getDb().prepare(
    `INSERT INTO model_providers (model_id, provider_id, api_model_id)
     VALUES ('gpt-4o', 'openai', 'gpt-4o')`,
  ).run();
}

const judgeConfig: EvaluationConfig = {
  judge: { enabled: true, model: 'gpt-4o' },
};

test('extractJsonObject parses raw JSON', () => {
  const parsed = extractJsonObject('{"scores": [{"category": "correctness", "score": 8}]}');
  assert.ok(parsed);
  assert.equal((parsed as any).scores[0].score, 8);
});

test('extractJsonObject parses fenced json blocks', () => {
  const text = 'Here is my assessment:\n```json\n{"scores": [], "summary": "great"}\n```\nHope that helps.';
  const parsed = extractJsonObject(text);
  assert.ok(parsed);
  assert.equal((parsed as any).summary, 'great');
});

test('extractJsonObject handles trailing text after JSON', () => {
  const text = '{"scores": [], "summary": "done"} -- end of response';
  const parsed = extractJsonObject(text);
  assert.ok(parsed);
  assert.equal((parsed as any).summary, 'done');
});

test('extractJsonObject returns null for malformed JSON and no-JSON responses', () => {
  assert.equal(extractJsonObject('{"scores": [}'), null);
  assert.equal(extractJsonObject('I am sorry, I could not produce a JSON verdict.'), null);
  assert.equal(extractJsonObject(''), null);
});

test('computeAverageScore is maxScore-weighted', () => {
  const scores = [
    { category: 'correctness', score: 10, maxScore: 10 },
    { category: 'fidelity', score: 0, maxScore: 20 },
  ];
  const avg = computeAverageScore(scores);
  assert.ok(Math.abs(avg - 100 / 30) < 0.001, `expected ~3.333, got ${avg}`);
});

test('computeAverageScore falls back to unweighted when maxScore is missing', () => {
  const scores = [
    { category: 'a', score: 8 },
    { category: 'b', score: 4 },
  ];
  assert.equal(computeAverageScore(scores), 6);
});

test('resolveJudgeApiKey reads from the secret store, not process.env directly', () => {
  const prev = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    assert.equal(resolveJudgeApiKey('OPENAI_API_KEY'), undefined);
    process.env.OPENAI_API_KEY = 'sk-test-123';
    assert.equal(resolveJudgeApiKey('OPENAI_API_KEY'), 'sk-test-123');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('runJudgeScoring returns a verdict but does not persist judge_scores (single persistence site is run-lifecycle)', async () => {
  freshDb();
  seedCatalog();

  const judgeAdapter = {
    sendMessage: async () => ({
      text: '```json\n{"scores": [{"category": "correctness", "score": 10, "maxScore": 10}, {"category": "fidelity", "score": 0, "maxScore": 20}], "summary": "Solid work"}\n```',
      usage: {},
      toolCalls: [],
    }),
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };

  try {
    const result = await runJudgeScoring('gpt-4o', 'run-123', 'Build an API', { 'server.ts': 'code' }, judgeConfig, undefined, judgeAdapter);
    assert.ok(result, 'expected a JudgeResult');
    assert.ok(Math.abs(result!.averageScore - 100 / 30) < 0.001);

    const rows = getDb().prepare('SELECT * FROM judge_scores WHERE run_id = ?').all('run-123') as any[];
    assert.equal(rows.length, 0, 'runJudgeScoring must not persist judge_scores rows directly');
  } finally {
    closeDb();
  }
});
