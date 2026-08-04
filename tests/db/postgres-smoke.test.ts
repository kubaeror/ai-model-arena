import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDrizzleDb } from '../../src/db/index.js';
import { migratePostgres, getPgClient } from '../../src/db/postgres.js';
import { insertSchedule, listDueSchedules, deleteSchedule } from '../../src/db/query.js';
import { insertCostLedgerEntry, getCostSummary } from '../../src/db/query.js';
import { transitionTaskState } from '../../src/db/query.js';
import { runs } from '../../src/db/schema-pg.js';

const isPg = process.env.DB_DRIVER === 'postgres';

test('postgres: migrations + Drizzle round-trip + task transition columns', { skip: !isPg }, async () => {
  initDb();
  await migratePostgres(getPgClient());
  try {
    const scheduleId = `pg-smoke-${Date.now()}`;
    const runId = `pg-smoke-run-${Date.now()}`;
    await insertSchedule({ id: scheduleId, scenario: 'express-rest', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true });
    const due = await listDueSchedules(new Date().toISOString());
    assert.ok(due.some((s: any) => s.id === scheduleId), 'schedules insert/list due via PG');
    await deleteSchedule(scheduleId);

    const db = getDrizzleDb();
    await db.insert(runs).values({
      run_id: runId, scenario: 'express-rest', models: JSON.stringify(['gpt-4o']),
      started_at: new Date().toISOString(), status: 'running', source: 'dashboard',
    });
    await insertCostLedgerEntry({
      runId, model: 'gpt-4o', costUsd: 0.5,
      inputTokens: 100, outputTokens: 20, recordedAt: new Date().toISOString(),
    });
    const byMonth = await getCostSummary('month', 'gpt-4o');
    assert.ok(Array.isArray(byMonth), 'cost summary (previously SQLite date()) runs on PG');

    await transitionTaskState(runId, 'gpt-4o', 'running', 'runner-test');
    assert.ok(true, 'transitionTaskState did not throw (run_models columns present)');
  } finally {
    await closeDb();
  }
});

test('postgres: Drizzle execute + typed helpers run on PG', { skip: !isPg }, async () => {
  initDb();
  try {
    const db = getDrizzleDb();
    const rows = await db.execute(db.sql`SELECT 1 AS ok`);
    assert.ok(rows, 'Drizzle execute works on PG');
  } finally {
    await closeDb();
  }
});
