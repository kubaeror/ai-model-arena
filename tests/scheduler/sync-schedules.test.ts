import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { dump, load } from 'js-yaml';
import { initDb, closeDb } from '../../src/db/index.js';
import { listSchedules } from '../../src/db/query.js';
import { loadSchedulesConfig, syncSchedulesToDb, resetSchedulesCache, getSchedule, setScheduleEnabled } from '../../src/scheduler/manager.js';

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

test('syncSchedulesToDb upserts hand-edited YAML changes into the DB', async () => {
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
  let row = (await listSchedules())[0];
  assert.equal(row.id, 's1');
  assert.equal(row.enabled, 1);
  assert.equal(row.scenario, 'x');
  assert.equal(row.cron, '0 3 * * *');

  // Operator hand-edits the YAML (disables + changes scenario/cron/models).
  fs.writeFileSync(configPath, dump({
    schedules: [
      { id: 's1', scenario: 'y', models: ['claude-sonnet-4'], cron: '0 6 * * *', enabled: false },
    ],
  }));
  resetSchedulesCache(); // simulate restart: config reloaded from disk
  await syncSchedulesToDb(configPath);

  row = (await listSchedules())[0];
  assert.equal(row.id, 's1', 'upsert keeps the single row');
  assert.equal((await listSchedules()).length, 1);
  assert.equal(row.enabled, 0, 'hand-edited enabled=false propagates');
  assert.equal(row.scenario, 'y', 'hand-edited scenario propagates');
  assert.equal(row.cron, '0 6 * * *', 'hand-edited cron propagates');
  assert.equal(JSON.parse(row.models as unknown as string)[0], 'claude-sonnet-4', 'hand-edited models propagate');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('setScheduleEnabled persists enabled flag to YAML, memory, and DB', async () => {
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
  assert.equal((await listSchedules())[0].enabled, 1);

  const ok = await setScheduleEnabled(configPath, 's1', false);
  assert.equal(ok, true);
  assert.equal(getSchedule('s1')?.enabled, false, 'in-memory schedule reflects disabled');

  const yaml = load(fs.readFileSync(configPath, 'utf8')) as { schedules: Array<{ enabled: boolean }> };
  assert.equal(yaml.schedules[0].enabled, false, 'YAML file persists enabled=false');

  assert.equal((await listSchedules())[0].enabled, 0, 'DB row reflects disabled');

  const okMissing = await setScheduleEnabled(configPath, 'does-not-exist', false);
  assert.equal(okMissing, false, 'unknown id returns false');

  const okBack = await setScheduleEnabled(configPath, 's1', true);
  assert.equal(okBack, true);
  assert.equal(getSchedule('s1')?.enabled, true);
  assert.equal((await listSchedules())[0].enabled, 1, 're-enable persists');

  fs.rmSync(dir, { recursive: true, force: true });
});
