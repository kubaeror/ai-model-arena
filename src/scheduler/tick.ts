import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { CronExpressionParser } from 'cron-parser';
import { updateScheduleState, getScheduleState } from './manager.js';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:scheduler');

export async function tickScheduler(): Promise<{ ticked: string[]; failures: string[] }> {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?) ORDER BY next_run",
  ).all(now) as Array<Record<string, unknown>>;

  const ticked: string[] = [];
  const failures: string[] = [];

  for (const row of rows) {
    const scheduleId = String(row.id);
    const next = computeNextRun(String(row.cron), new Date(now));
    db.prepare('UPDATE schedules SET last_run = ?, next_run = ? WHERE id = ?').run(now, next, String(row.id));

    // Update scheduler state for observability
    const state = getScheduleState(scheduleId) ?? { id: scheduleId, status: 'idle', consecutiveFailures: 0, totalRuns: 0, totalFailures: 0 };
    updateScheduleState(scheduleId, {
      status: 'running',
      lastRun: now,
      nextRun: next,
    });

    const models = JSON.parse(String(row.models)) as string[];
    let scheduleFailed = false;

    for (const model of models) {
      try {
        const { createQueue } = await import('../queue/index.js');
        const queue = createQueue();
        await queue.enqueue({
          taskId: `sched-${scheduleId}-${model}-${Date.now()}`,
          sessionId: crypto.randomUUID(),
          provider: model.split(':')[0] ?? model,
          model,
          scenario: String(row.scenario),
          config: {},
          enqueuedAt: now,
          attempts: 0,
        });
      } catch (err) {
        scheduleFailed = true;
        logger.warn('Schedule enqueue failed', {
          scheduleId,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (scheduleFailed) {
      failures.push(scheduleId);
      updateScheduleState(scheduleId, {
        status: 'error',
        lastError: 'Failed to enqueue one or more model tasks',
        consecutiveFailures: (state.consecutiveFailures ?? 0) + 1,
        totalRuns: (state.totalRuns ?? 0) + 1,
        totalFailures: (state.totalFailures ?? 0) + 1,
      });

      if ((state.consecutiveFailures ?? 0) >= 3) {
        logger.error('Schedule has 3+ consecutive failures', {
          scheduleId,
          consecutiveFailures: (state.consecutiveFailures ?? 0) + 1,
        });
      }
    } else {
      ticked.push(scheduleId);
      updateScheduleState(scheduleId, {
        status: 'idle',
        consecutiveFailures: 0,
        totalRuns: (state.totalRuns ?? 0) + 1,
      });
    }
  }

  return { ticked, failures };
}

function computeNextRun(cron: string, from: Date): string {
  try {
    const interval = CronExpressionParser.parse(cron);
    return (interval.next().toDate() as Date).toISOString();
  } catch {
    return new Date(from.getTime() + 3600000).toISOString();
  }
}
