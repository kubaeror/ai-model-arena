import { listDueSchedules, updateScheduleRun } from '../db/query.js';
import { CronExpressionParser } from 'cron-parser';
import { updateScheduleState, getScheduleState } from './manager.js';
import { createLogger } from '../logger/pino-logger.js';
import { scheduleFailures } from '../observability/metrics.js';

const logger = createLogger('ai-arena:scheduler');

export async function tickScheduler(): Promise<{ ticked: string[]; failures: string[] }> {
  const now = new Date().toISOString();
  const rows = await listDueSchedules(now);

  const ticked: string[] = [];
  const failures: string[] = [];

  for (const row of rows) {
    const scheduleId = row.id;
    const nowMs = new Date(now).getTime();
    const next = computeNextRun(row.cron, new Date(now));

    // Update scheduler state for observability
    const state = getScheduleState(scheduleId) ?? { id: scheduleId, status: 'idle', consecutiveFailures: 0, totalRuns: 0, totalFailures: 0 };
    updateScheduleState(scheduleId, {
      status: 'running',
      lastRun: now,
      nextRun: next,
    });

    const models = JSON.parse(String(row.models)) as string[];
    let scheduleFailed = false;

    try {
      // Route through startRun() for proper budget check + run registration
      const { startRun } = await import('../orchestrator/run-lifecycle.js');
      await startRun({
        scenario: String(row.scenario),
        models,
        source: 'scheduler',
      });
    } catch (err) {
      scheduleFailed = true;
      logger.warn('Schedule startRun failed', {
        scheduleId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // next_run advances only on success; a failed attempt backs off 1h so a
    // persistently broken schedule does not hot-loop every tick.
    if (scheduleFailed) {
      const backoff = new Date(nowMs + 3600000).toISOString();
      await updateScheduleRun(scheduleId, now, backoff);
      scheduleFailures.inc({ schedule_id: scheduleId });
      failures.push(scheduleId);
      const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      updateScheduleState(scheduleId, {
        status: 'error',
        lastError: 'Failed to enqueue one or more model tasks',
        consecutiveFailures,
        totalRuns: (state.totalRuns ?? 0) + 1,
        totalFailures: (state.totalFailures ?? 0) + 1,
      });

      if (consecutiveFailures >= 3) {
        logger.error('Schedule has 3+ consecutive failures', {
          scheduleId,
          consecutiveFailures,
        });
      }
    } else {
      await updateScheduleRun(scheduleId, now, next);
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
