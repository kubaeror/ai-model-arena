import { listDueSchedules, updateScheduleRun, updateScheduleStatus } from '../db/query.js';
import { CronExpressionParser } from 'cron-parser';
import { updateScheduleState, getScheduleState, getSchedule } from './manager.js';
import { createLogger } from '../logger/pino-logger.js';
import { scheduleFailures } from '../observability/metrics.js';
import type { RunStartOptions } from '../orchestrator/run-lifecycle.js';

const logger = createLogger('ai-arena:scheduler');

function nextCounters(base: { consecutiveFailures?: number; totalRuns?: number; totalFailures?: number }, failed: boolean): { consecutiveFailures: number; totalRuns: number; totalFailures: number } {
  return {
    consecutiveFailures: failed ? (base.consecutiveFailures ?? 0) + 1 : 0,
    totalRuns: (base.totalRuns ?? 0) + 1,
    totalFailures: (base.totalFailures ?? 0) + (failed ? 1 : 0),
  };
}

export async function tickScheduler(opts: { now?: Date; startRunFn?: (runOptions: RunStartOptions) => Promise<unknown> } = {}): Promise<{ ticked: string[]; failures: string[] }> {
  const now = opts.now?.toISOString() ?? new Date().toISOString();
  const start = opts.startRunFn ?? (await import('../orchestrator/run-lifecycle.js')).startRun;
  const rows = await listDueSchedules(now);

  const ticked: string[] = [];
  const failures: string[] = [];

  for (const row of rows) {
    const scheduleId = row.id;
    const nowMs = new Date(now).getTime();
    const next = computeNextRun(row.cron);
    let failureReason = '';
    if (next === null) {
      failureReason = `Invalid cron expression: ${row.cron}`;
      logger.error(failureReason, { scheduleId });
    }

    // Update scheduler state for observability
    const state = getScheduleState(scheduleId) ?? {
      id: scheduleId, status: 'idle',
      consecutiveFailures: row.consecutive_failures ?? 0,
      totalRuns: row.total_runs ?? 0,
      totalFailures: row.total_failures ?? 0,
    };
    updateScheduleState(scheduleId, {
      status: failureReason ? 'error' : 'running',
      lastRun: now,
      ...(next ? { nextRun: next } : {}),
    });
    // Persist to the DB (fire-and-forget, non-fatal) so the dashboard sees
    // the running state even if the pod dies mid-tick.
    void updateScheduleStatus(scheduleId, { lastStatus: failureReason ? 'error' : 'running', lastError: failureReason || null })
      .catch(() => undefined);

    const models = JSON.parse(String(row.models)) as string[];
    let scheduleFailed = false;

    if (failureReason) {
      scheduleFailed = true;
    } else {
      try {
        // Route through startRun() for proper budget check + run registration.
        // Per-schedule options (forceBudget) come from the YAML config, not the
        // DB row — join via the in-memory schedule record.
        const schedule = getSchedule(scheduleId);
        if (!schedule) {
          logger.warn('Schedule due in DB but missing from loaded schedules config; options (forceBudget) will not be applied', { scheduleId });
        }
        const runOptions: RunStartOptions = {
          scenario: String(row.scenario),
          models,
          source: 'scheduler',
        };
        if (schedule?.options?.forceBudget !== undefined) runOptions.forceBudget = schedule.options.forceBudget;
        await start(runOptions);
      } catch (err) {
        scheduleFailed = true;
        failureReason = err instanceof Error ? err.message : String(err);
        logger.warn('Schedule startRun failed', {
          scheduleId,
          error: failureReason,
        });
      }
    }

    // next_run advances only on success; a failed attempt backs off
    // SCHEDULER_FAILURE_BACKOFF_MS (default 1h) so a persistently broken
    // schedule does not hot-loop every tick.
    if (scheduleFailed) {
      const backoffMs = Number(process.env.SCHEDULER_FAILURE_BACKOFF_MS ?? 3_600_000);
      const backoff = new Date(nowMs + (Number.isFinite(backoffMs) && backoffMs > 0 ? backoffMs : 3_600_000)).toISOString();
      await updateScheduleRun(scheduleId, now, backoff);
      scheduleFailures.inc({ schedule_id: scheduleId });
      failures.push(scheduleId);
      const counters = nextCounters(state, true);
      const consecutiveFailures = counters.consecutiveFailures;
      updateScheduleState(scheduleId, {
        status: 'error',
        lastError: failureReason,
        ...counters,
      });
      // Seed counters from the DB row so restarts don't regress totals.
      await updateScheduleStatus(scheduleId, {
        lastStatus: 'error',
        lastError: failureReason,
        ...nextCounters({ consecutiveFailures: row.consecutive_failures, totalRuns: row.total_runs, totalFailures: row.total_failures }, true),
      });

      if (consecutiveFailures >= 3) {
        logger.error('Schedule has 3+ consecutive failures', {
          scheduleId,
          consecutiveFailures,
        });
      }
    } else {
      // scheduleFailed implies failureReason set (and next === null), so here
      // the cron parsed and `next` is a real timestamp.
      await updateScheduleRun(scheduleId, now, next!);
      ticked.push(scheduleId);
      updateScheduleState(scheduleId, {
        status: 'idle',
        ...nextCounters(state, false),
      });
      // Seed counters from the DB row so restarts don't regress totals.
      await updateScheduleStatus(scheduleId, {
        lastStatus: 'idle',
        ...nextCounters({ consecutiveFailures: row.consecutive_failures, totalRuns: row.total_runs, totalFailures: row.total_failures }, false),
      });
    }
  }

  return { ticked, failures };
}

function computeNextRun(cron: string): string | null {
  try {
    const interval = CronExpressionParser.parse(cron);
    return (interval.next().toDate() as Date).toISOString();
  } catch (err) {
    logger.error('Invalid cron expression', {
      cron,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
