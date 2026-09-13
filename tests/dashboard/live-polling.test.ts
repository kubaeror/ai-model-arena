import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { listLiveRuns } from '../../src/db/runs.js';
import { readLogAppend, LiveHub } from '../../src/dashboard-server/live.js';
import { signToken, type AuthConfig } from '../../src/dashboard-server/auth.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function insertRun(
  db: ReturnType<typeof getDb>,
  runId: string,
  status: string,
  startedAt: string,
): void {
  db.prepare(
    'INSERT INTO runs (run_id, scenario, models, started_at, status, source) VALUES (?,?,?,?,?,?)',
  ).run(runId, 'smoke', '["gpt-4o"]', startedAt, status, 'cli');
}

test('listLiveRuns returns active runs plus only a bounded recent window', async () => {
  const tmp = tempDir('arena-live-runs-');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.DB_DRIVER = 'sqlite';
  initDb(process.env.ARENA_DB_PATH);
  const db = getDb();
  const oldTs = new Date(Date.now() - 40 * MS_PER_DAY).toISOString();
  const recentTs = new Date(Date.now() - 60_000).toISOString();

  try {
    insertRun(db, 'active-old', 'running', oldTs);
    insertRun(db, 'finalizing-old', 'finalizing', oldTs);
    insertRun(db, 'completed-old', 'completed', oldTs);
    insertRun(db, 'errored-old', 'errored', oldTs);
    insertRun(db, 'completed-recent', 'completed', recentTs);
    db.prepare('INSERT INTO run_models (run_id, model, status) VALUES (?,?,?)').run('active-old', 'gpt-4o', 'running');
    db.prepare('INSERT INTO run_models (run_id, model, status) VALUES (?,?,?)').run('completed-old', 'ghost-model', 'completed');

    const live = await listLiveRuns();
    assert.deepEqual(
      live.map((r) => r.runId).sort(),
      ['active-old', 'completed-recent', 'finalizing-old'],
      'only active runs and the recent window are returned',
    );
    const active = live.find((r) => r.runId === 'active-old');
    assert.deepEqual(active?.perModel.map((m) => m.model), ['gpt-4o']);
    assert.ok(
      live.every((r) => r.perModel.every((m) => m.model !== 'ghost-model')),
      'per-model rows for out-of-window runs must not be loaded',
    );
  } finally {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readLogAppend tails only new bytes on append', async () => {
  const filePath = path.join(tempDir('arena-log-append-'), 'run.log');
  fs.writeFileSync(filePath, 'one\ntwo\n');

  const first = await readLogAppend(filePath, 0);
  assert.deepEqual(first.lines, ['one', 'two']);
  assert.equal(first.offset, fs.statSync(filePath).size);

  fs.appendFileSync(filePath, 'three\n');
  const second = await readLogAppend(filePath, first.offset);
  assert.deepEqual(second.lines, ['three']);
  assert.equal(second.offset, fs.statSync(filePath).size);

  const idle = await readLogAppend(filePath, second.offset);
  assert.deepEqual(idle.lines, []);
});

test('readLogAppend resets to the start when the log shrank instead of stalling', async () => {
  const filePath = path.join(tempDir('arena-log-truncate-'), 'run.log');
  fs.writeFileSync(filePath, 'first\nsecond\n');
  const first = await readLogAppend(filePath, 0);
  assert.ok(first.offset > 0);

  fs.writeFileSync(filePath, 'new\n');
  const afterTruncate = await readLogAppend(filePath, first.offset);
  assert.deepEqual(afterTruncate.lines, ['new']);
  assert.equal(afterTruncate.offset, fs.statSync(filePath).size);

  const continued = await readLogAppend(filePath, afterTruncate.offset);
  assert.deepEqual(continued.lines, []);
  assert.equal(continued.offset, afterTruncate.offset);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('condition was not met before the timeout');
}

function waitForMessage(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timed out waiting for a ${type} frame`));
    }, 5000);
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === type) {
        clearTimeout(timeout);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

test('LiveHub clears per-run tail state when the last subscriber unsubscribes or disconnects', async () => {
  const tmp = tempDir('arena-live-state-');
  const outputs = path.join(tmp, 'outputs');
  process.env.ARENA_DB_PATH = path.join(tmp, 'test.db');
  process.env.OUTPUT_ROOT = outputs;
  process.env.DB_DRIVER = 'sqlite';
  delete process.env.DASHBOARD_REDIS_URL;
  initDb(process.env.ARENA_DB_PATH);
  const db = getDb();

  const runId = 'run-live-state';
  const runDir = path.join(outputs, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const conversationPath = path.join(runDir, 'conversation.json');
  const logFile = path.join(runDir, 'run.log');
  const startedAt = new Date().toISOString();
  fs.writeFileSync(conversationPath, JSON.stringify({
    model: 'gpt-4o', scenario: 'smoke', runId, startedAt,
    entries: [{ type: 'user', content: 'hi', timestamp: startedAt }],
  }));
  fs.writeFileSync(logFile, 'boot\n');
  insertRun(db, runId, 'running', startedAt);
  db.prepare(
    'INSERT INTO run_models (run_id, model, status, conversation_path, log_file) VALUES (?,?,?,?,?)',
  ).run(runId, 'gpt-4o', 'running', conversationPath, logFile);

  const auth: AuthConfig = {
    username: 'admin', password: 'admin-pass',
    secret: 'test-secret-0123456789abcdef', expiresIn: '1h',
  };
  const token = signToken(auth, 'admin-user', 'admin');
  const server = http.createServer();
  const hub = new LiveHub(server, auth);
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const state = hub as unknown as {
    convSeen: Map<string, number>;
    convMtime: Map<string, number>;
    logOffset: Map<string, number>;
    logMtime: Map<string, number>;
  };
  const idle = state;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [token]);
  try {
    await once(ws, 'open');

    const firstSnapshot = waitForMessage(ws, 'conversation_snapshot');
    ws.send(JSON.stringify({ type: 'subscribe', runId }));
    await firstSnapshot;
    await waitUntil(() => idle.convSeen.size > 0 && idle.convMtime.size > 0);
    await waitUntil(() => idle.logOffset.size > 0 && idle.logMtime.size > 0, 5000);

    ws.send(JSON.stringify({ type: 'unsubscribe', runId }));
    await waitUntil(() =>
      idle.convSeen.size === 0 && idle.convMtime.size === 0
      && idle.logOffset.size === 0 && idle.logMtime.size === 0,
    );

    const secondSnapshot = waitForMessage(ws, 'conversation_snapshot');
    ws.send(JSON.stringify({ type: 'subscribe', runId }));
    await secondSnapshot;
    await waitUntil(() => idle.convSeen.size > 0);

    ws.close();
    await once(ws, 'close');
    await waitUntil(() =>
      idle.convSeen.size === 0 && idle.convMtime.size === 0
      && idle.logOffset.size === 0 && idle.logMtime.size === 0,
    );
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    hub.close();
    server.close();
    server.closeIdleConnections();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
