import crypto from 'node:crypto';
import { getDb } from '../db/client.js';
import { CronExpressionParser } from 'cron-parser';

export async function tickScheduler(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?) ORDER BY next_run",
  ).all(now) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const next = computeNextRun(String(row.cron), new Date(now));
    db.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?').run(now, next, String(row.id));

    const models = JSON.parse(String(row.models)) as string[];
    for (const model of models) {
      try {
        const { createQueue } = await import('../queue/index.js');
        const queue = createQueue();
        await queue.enqueue({
          taskId: `sched-${String(row.id)}-${model}-${Date.now()}`,
          sessionId: crypto.randomUUID(),
          provider: model.split(':')[0] ?? model,
          model,
          scenario: String(row.scenario),
          config: {},
          enqueuedAt: now,
          attempts: 0,
        });
      } catch {
        /* tick failure non-fatal */
      }
    }
  }
}

function computeNextRun(cron: string, from: Date): string {
  try {
    const interval = CronExpressionParser.parse(cron);
    return (interval.next().toDate() as Date).toISOString();
  } catch {
    return new Date(from.getTime() + 3600000).toISOString();
  }
}
