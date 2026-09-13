import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { closeDb, getDrizzleDb, initDb } from '../../src/db/index.js';
import { run_models, runs, tool_call_stats } from '../../src/db/schema.js';

test('analytics /tools counts a DB-covered successful run once (failedRate never negative)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-analytics-'));
  const outputDir = path.join(dir, 'run-success-1');
  const resultPath = path.join(outputDir, 'result.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({ success: true }));

  process.env.AI_ARENA_ROOT = dir;
  process.env.OUTPUT_ROOT = dir;
  process.env.ARENA_DB_PATH = path.join(dir, 'arena.db');
  initDb(path.join(dir, 'arena.db'));

  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(runs).values({
    run_id: 'run-success-1', scenario: 'smoke', models: '["gpt-4o"]',
    started_at: now, finished_at: now, status: 'completed', source: 'cli',
  });
  await db.insert(run_models).values({
    run_id: 'run-success-1', model: 'gpt-4o', status: 'completed', success: 1,
    output_dir: outputDir, sandbox_dir: path.join(outputDir, 'sandbox'),
    result_path: resultPath, conversation_path: path.join(outputDir, 'conversation.json'),
    report_path: path.join(outputDir, 'report.md'), log_file: path.join(outputDir, 'run.log'),
  });
  // Presence of tool_call_stats makes the run "DB-covered" so the file-based
  // and run_models-based success paths both see it.
  await db.insert(tool_call_stats).values({
    run_id: 'run-success-1', model: 'gpt-4o', tool_name: 'file_read',
    total: 2, success_count: 2, fail_count: 0, recorded_at: now,
  });

  const { createAnalyticsRouter } = await import('../../src/dashboard-server/routes/analytics.js');
  const app = express();
  app.use('/api/analytics', createAnalyticsRouter());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${base}/api/analytics/tools`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { totalRuns: number; successfulRuns: number; failedRate: number; totalToolCalls: number };
    assert.equal(body.totalRuns, 1);
    assert.equal(body.successfulRuns, 1, 'a covered success is counted once, not once per source');
    assert.equal(body.totalToolCalls, 2);
    assert.ok(body.failedRate >= 0, `failedRate must never be negative, got ${body.failedRate}`);
    assert.equal(body.failedRate, 0);
  } finally {
    server.close();
    server.closeIdleConnections();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AI_ARENA_ROOT;
    delete process.env.OUTPUT_ROOT;
    delete process.env.ARENA_DB_PATH;
  }
});

test('analytics /tools scopes success rows and DB coverage to the filtered model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-analytics-model-'));
  process.env.AI_ARENA_ROOT = dir;
  process.env.OUTPUT_ROOT = dir;
  process.env.ARENA_DB_PATH = path.join(dir, 'arena.db');
  initDb(path.join(dir, 'arena.db'));

  const db = getDrizzleDb();
  const now = new Date().toISOString();

  // run-both: gpt-4o succeeded, claude-sonnet failed, both DB-covered.
  const bothDir = path.join(dir, 'run-both');
  fs.mkdirSync(bothDir, { recursive: true });
  fs.writeFileSync(path.join(bothDir, 'gpt-4o.json'), JSON.stringify({ success: true }));
  fs.writeFileSync(path.join(bothDir, 'claude-sonnet.json'), JSON.stringify({ success: false }));
  await db.insert(runs).values({
    run_id: 'run-both', scenario: 'smoke', models: '["gpt-4o","claude-sonnet"]',
    started_at: now, finished_at: now, status: 'completed', source: 'cli',
  });
  await db.insert(run_models).values([
    { run_id: 'run-both', model: 'gpt-4o', status: 'completed', success: 1, result_path: path.join(bothDir, 'gpt-4o.json') },
    { run_id: 'run-both', model: 'claude-sonnet', status: 'completed', success: 0, result_path: path.join(bothDir, 'claude-sonnet.json') },
  ]);
  await db.insert(tool_call_stats).values([
    { run_id: 'run-both', model: 'gpt-4o', tool_name: 'file_read', total: 2, success_count: 2, fail_count: 0, recorded_at: now },
    { run_id: 'run-both', model: 'claude-sonnet', tool_name: 'file_read', total: 3, success_count: 1, fail_count: 2, recorded_at: now },
  ]);

  // run-file: claude-sonnet has no DB stats (file fallback), but the run has
  // gpt-4o stats. Those must not mark claude-sonnet's run as DB-covered.
  const fileDir = path.join(dir, 'run-file');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(path.join(fileDir, 'claude-sonnet.json'), JSON.stringify({ success: true }));
  fs.writeFileSync(path.join(fileDir, 'claude-sonnet-conv.json'), JSON.stringify({
    entries: [{ type: 'assistant', turn: 1 }, { type: 'tool_call', turn: 1, toolName: 'shell_exec' }],
  }));
  await db.insert(runs).values({
    run_id: 'run-file', scenario: 'smoke', models: '["claude-sonnet"]',
    started_at: now, finished_at: now, status: 'completed', source: 'cli',
  });
  await db.insert(run_models).values({
    run_id: 'run-file', model: 'claude-sonnet', status: 'completed', success: 1,
    result_path: path.join(fileDir, 'claude-sonnet.json'), conversation_path: path.join(fileDir, 'claude-sonnet-conv.json'),
  });
  await db.insert(tool_call_stats).values({
    run_id: 'run-file', model: 'gpt-4o', tool_name: 'file_read', total: 1, success_count: 1, fail_count: 0, recorded_at: now,
  });

  const { createAnalyticsRouter } = await import('../../src/dashboard-server/routes/analytics.js');
  const app = express();
  app.use('/api/analytics', createAnalyticsRouter());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Body = { totalRuns: number; successfulRuns: number; failedRate: number; totalToolCalls: number };
  try {
    const failedModel = (await fetch(`${base}/api/analytics/tools?model=claude-sonnet`).then(r => r.json())) as Body;
    assert.equal(failedModel.totalRuns, 2);
    assert.equal(failedModel.successfulRuns, 1, "gpt-4o's success must not count for the claude-sonnet filter");
    assert.equal(failedModel.failedRate, 0.5);
    assert.equal(failedModel.totalToolCalls, 4, 'claude-sonnet file fallback must still count when only gpt-4o has DB stats');

    const succeededModel = (await fetch(`${base}/api/analytics/tools?model=gpt-4o`).then(r => r.json())) as Body;
    assert.equal(succeededModel.totalRuns, 1);
    assert.equal(succeededModel.successfulRuns, 1, "claude-sonnet's success must not count for the gpt-4o filter");
    assert.equal(succeededModel.failedRate, 0);
  } finally {
    server.close();
    server.closeIdleConnections();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AI_ARENA_ROOT;
    delete process.env.OUTPUT_ROOT;
    delete process.env.ARENA_DB_PATH;
  }
});
