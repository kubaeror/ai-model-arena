import { test, after, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/index.js';
import {
  persistNotification,
  getNotificationById,
  startNotificationOutboxTimer,
} from '../../src/notifications/outbox.js';
import { DispatchEventType } from '../../src/notifications/types.js';
import type { Logger } from '../../src/types.js';

/**
 * Boot robustness: a malformed/schema-invalid notifications.yaml must not kill
 * the dashboard at startup. The outbox timer is expected to log a warning and
 * keep sweeping; without channels loaded, sends fail gracefully and stay
 * retryable. Kept in its own file because loadNotificationConfig memoizes the
 * first successful config process-wide.
 */

const warnings: string[] = [];
const trackingLogger: Logger = {
  info: () => {},
  warn: (msg: string) => { warnings.push(msg); },
  error: () => {},
  debug: () => {},
  child: () => trackingLogger,
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-notif-boot-'));
const malformedConfigPath = path.join(tmpDir, 'notifications.yaml');
fs.writeFileSync(malformedConfigPath, 'channels: [this is not valid yaml');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await closeDb();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('malformed notifications config: boot warns and the outbox timer still sweeps', async (t: TestContext) => {
  initDb(':memory:');
  t.mock.timers.enable({ apis: ['setInterval'] });

  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'bad-cfg' } },
    'slack',
  );

  const timer = startNotificationOutboxTimer(trackingLogger, malformedConfigPath, { intervalMs: 1_000 });
  try {
    assert.ok(
      warnings.some((msg) => /notification config/i.test(msg)),
      'boot logs a warning for the bad config instead of throwing',
    );

    t.mock.timers.tick(1_000);
    await flush();

    const row = await getNotificationById(id);
    assert.equal(row?.status, 'pending', 'channel-less send failed gracefully and stayed retryable');
    assert.equal(row?.attempts, 1);
    assert.match(row?.lastError ?? '', /Channel "slack" not found/);
  } finally {
    timer.stop();
    t.mock.timers.reset();
  }
});
