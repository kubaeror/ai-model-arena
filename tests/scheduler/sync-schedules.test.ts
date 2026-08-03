import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { dump } from 'js-yaml';
import { initDb, closeDb } from '../../src/db/index.js';
import { listSchedules } from '../../src/db/query.js';
import { loadSchedulesConfig, syncSchedulesToDb, resetSchedulesCache } from '../../src/scheduler/manager.js';

afterEach(async () => {
  resetSchedulesCache();
  await closeDb();
});

test('syncSchedulesToDb mirrors YAML schedules idempotently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sync-'));
  const configPath = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(configPath, dump({
    schedules: [
      { id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true },
    ],
  }));
  initDb(path.join(dir, 'arena.db'));

  loadSchedulesConfig(configPath);
  await syncSchedulesToDb(configPath);

  let rows = await listSchedules();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
  assert.equal(rows[0].enabled, 1);

  await syncSchedulesToDb(configPath);
  rows = await listSchedules();
  assert.equal(rows.length, 1, 'second sync must not duplicate rows');

  fs.rmSync(dir, { recursive: true, force: true });
});
