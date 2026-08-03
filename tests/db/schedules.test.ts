import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDb, closeDb } from '../../src/db/index.js';
import { insertSchedule, listSchedules, deleteSchedule, listDueSchedules } from '../../src/db/query.js';

afterEach(async () => {
  await closeDb();
});

test('schedules: insert/idempotent/list/delete + due', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-'));
  initDb(path.join(dir, 'arena.db'));
  await insertSchedule({ id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true });
  await insertSchedule({ id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true });
  assert.equal((await listSchedules()).length, 1);
  assert.equal((await listDueSchedules(new Date().toISOString())).length, 1);
  await deleteSchedule('s1');
  assert.equal((await listSchedules()).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
