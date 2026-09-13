import { test, after, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/index.js';
import { persistNotification, startNotificationOutboxTimer } from '../../src/notifications/outbox.js';
import { sendNotification } from '../../src/notifications/index.js';
import { DispatchEventType } from '../../src/notifications/types.js';
import type { Logger } from '../../src/types.js';

/**
 * Dashboard outbox timer: boot must load channel config (otherwise
 * sendNotification reports "Channel not found") and overlapping interval
 * ticks must not start a second concurrent sweep.
 */

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-notif-timer-'));
const configPath = path.join(tmpDir, 'notifications.yaml');
fs.writeFileSync(configPath, [
  'channels:',
  '  ops:',
  '    type: slack',
  '    webhookUrl: http://hooks.example.test/ops',
  '',
].join('\n'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await closeDb();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('starting the outbox timer loads channel config before the first sweep', async () => {
  initDb(':memory:');
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  const timer = startNotificationOutboxTimer(silentLogger, configPath, { intervalMs: 60_000 });
  try {
    const result = await sendNotification('ops', {
      type: DispatchEventType.onRunCompleted,
      data: { runId: 'r-boot' },
    });
    assert.equal(result.success, true, `expected a real send attempt, got: ${result.error}`);
    assert.deepEqual(calls, ['http://hooks.example.test/ops']);
  } finally {
    timer.stop();
    globalThis.fetch = originalFetch;
  }
});

test('overlapping outbox ticks are skipped while a sweep is in flight', async (t: TestContext) => {
  initDb(':memory:');
  t.mock.timers.enable({ apis: ['setInterval'] });

  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sender = async () => {
    sends++;
    await gate;
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  };

  const timer = startNotificationOutboxTimer(silentLogger, configPath, { intervalMs: 1_000, sender });
  try {
    await persistNotification({ type: DispatchEventType.onRunCompleted, data: { runId: 'r1' } }, 'slack');
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(sends, 1, 'first tick starts a sweep');

    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(sends, 1, 'tick during an in-flight sweep is skipped');

    release();
    await flush();

    await persistNotification({ type: DispatchEventType.onRunCompleted, data: { runId: 'r2' } }, 'slack');
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(sends, 2, 'a later tick sweeps again after the in-flight sweep finishes');
  } finally {
    timer.stop();
    t.mock.timers.reset();
  }
});
