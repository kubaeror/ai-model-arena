import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { dump, load } from 'js-yaml';
import { initDb, closeDb } from '../../src/db/index.js';
import { listSchedules, updateScheduleStatus } from '../../src/db/query.js';
import { resetSchedulesCache } from '../../src/scheduler/manager.js';

test('GET /api/schedules returns persisted DB state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-routes-db-'));
  const configPath = path.join(dir, 'configs', 'schedules.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, dump({
    schedules: [
      { id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true },
      { id: 's2', scenario: 'y', models: ['gpt-4o'], cron: '0 4 * * *', enabled: true },
    ],
  }));

  process.env.AI_ARENA_ROOT = dir;
  process.env.OUTPUT_ROOT = dir;
  resetSchedulesCache();
  initDb(path.join(dir, 'arena.db'));
  const { syncSchedulesToDb } = await import('../../src/scheduler/manager.js');
  await syncSchedulesToDb(configPath);
  await updateScheduleStatus('s1', {
    lastStatus: 'error', lastError: 'boom',
    consecutiveFailures: 2, totalRuns: 5, totalFailures: 3,
  });
  await updateScheduleStatus('s2', { lastStatus: 'idle', consecutiveFailures: 0, totalRuns: 1, totalFailures: 0 });

  const { createSchedulesRouter } = await import('../../src/dashboard-server/routes/schedules.js');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/schedules', createSchedulesRouter());

  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const listRes = await fetch(`${base}/api/schedules`);
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as {
      schedules: Array<{ id: string; state: { status: string; lastError: string | null; consecutiveFailures: number; totalRuns: number; totalFailures: number } | null }>;
    };

    const s1 = listBody.schedules.find((s) => s.id === 's1')!;
    assert.equal(s1.state?.status, 'error', 'GET / returns persisted last_status');
    assert.equal(s1.state?.lastError, 'boom');
    assert.equal(s1.state?.consecutiveFailures, 2);
    assert.equal(s1.state?.totalRuns, 5);
    assert.equal(s1.state?.totalFailures, 3);

    const s2 = listBody.schedules.find((s) => s.id === 's2')!;
    assert.equal(s2.state?.status, 'idle');
    assert.equal(s2.state?.totalRuns, 1);

    const detailRes = await fetch(`${base}/api/schedules/s1`);
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as { id: string; state: { status: string } | null };
    assert.equal(detail.id, 's1');
    assert.equal(detail.state?.status, 'error', 'GET /:id returns persisted last_status');
  } finally {
    server.close();
    resetSchedulesCache();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/schedules/:id toggles enabled, persists to YAML, and returns the updated record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-routes-'));
  const configPath = path.join(dir, 'configs', 'schedules.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, dump({
    schedules: [
      { id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true },
    ],
  }));

  process.env.AI_ARENA_ROOT = dir;
  process.env.OUTPUT_ROOT = dir;
  resetSchedulesCache();
  initDb(path.join(dir, 'arena.db'));
  const { syncSchedulesToDb } = await import('../../src/scheduler/manager.js');
  await syncSchedulesToDb(configPath);

  const { createSchedulesRouter } = await import('../../src/dashboard-server/routes/schedules.js');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'admin', role: 'admin' };
    next();
  });
  app.use('/api/schedules', createSchedulesRouter());

  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const patch = (id: string, body: unknown) =>
      fetch(`${base}/api/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const res = await patch('s1', { enabled: false });
    assert.equal(res.status, 200);
    const updated = (await res.json()) as { id: string; enabled: boolean };
    assert.equal(updated.id, 's1');
    assert.equal(updated.enabled, false, 'response returns updated record with enabled=false');

    const yaml = load(fs.readFileSync(configPath, 'utf8')) as { schedules: Array<{ enabled: boolean }> };
    assert.equal(yaml.schedules[0]!.enabled, false, 'PATCH rewrote schedules.yaml');

    const listRes = await fetch(`${base}/api/schedules`);
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { schedules: Array<{ id: string; enabled: boolean }> };
    assert.equal(listBody.schedules[0]!.enabled, false, 'GET reflects disabled');

    const nf = await patch('does-not-exist', { enabled: false });
    assert.equal(nf.status, 404);

    const bad = await patch('s1', { enabled: 'yes' });
    assert.equal(bad.status, 400, 'non-boolean enabled rejected');

    const on = await patch('s1', { enabled: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json() as { enabled: boolean }).enabled, true, 're-enable returns updated record');

    assert.equal((await listSchedules())[0]!.enabled, 1, 'DB row re-enabled');
  } finally {
    server.close();
    resetSchedulesCache();
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
