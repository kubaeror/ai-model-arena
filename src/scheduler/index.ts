import type { Logger } from '../types.js';
import { getSchedules } from './manager.js';
import { startRun } from '../orchestrator/run-lifecycle.js';
import { dispatchNotification, DispatchEventType } from '../notifications/index.js';
import type { Schedule } from './types.js';

const scheduledJobs = new Map<string, NodeJS.Timeout>();

function parseCron(expr: string): { minute: number | null; hour: number | null; dow: number | null } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }
  
  const parsePart = (p: string): number | null => {
    if (p === '*') return null;
    return parseInt(p, 10);
  };
  
  return {
    minute: parsePart(parts[0]!),
    hour: parsePart(parts[1]!),
    dow: parts.length >= 5 ? parsePart(parts[4]!) : null,
  };
}

function getNextRunTime(cronExpr: string, now: Date = new Date()): Date {
  const parsed = parseCron(cronExpr);
  const next = new Date(now);
  
  if (parsed.minute !== null) {
    next.setMinutes(parsed.minute, 0, 0);
  }
  
  if (parsed.hour !== null) {
    next.setHours(parsed.hour);
  }
  
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  
  if (parsed.dow !== null) {
    const currentDow = next.getDay();
    if (currentDow !== parsed.dow) {
      const daysUntil = (parsed.dow - currentDow + 7) % 7;
      next.setDate(next.getDate() + daysUntil);
    }
  }
  
  return next;
}

function msUntilNextRun(cronExpr: string): number {
  const next = getNextRunTime(cronExpr);
  return next.getTime() - Date.now();
}

async function executeSchedule(schedule: Schedule, logger?: Logger): Promise<void> {
  const scheduleLogger = logger?.child('scheduler');
  scheduleLogger?.info('Executing scheduled run', { scheduleId: schedule.id });
  
  try {
    const spec = await startRun({
      scenario: schedule.scenario,
      models: schedule.models,
      forceBudget: schedule.options?.forceBudget ?? false,
      timeoutMs: schedule.options?.timeoutMs,
      source: 'scheduler',
      logger: scheduleLogger,
    });
    
    scheduleLogger?.info('Scheduled run started', { 
      scheduleId: schedule.id, 
      runId: spec.runId 
    });
    
    if (schedule.notifications && schedule.notifications.length > 0) {
      void dispatchNotification({
        type: DispatchEventType.onRunCompleted,
        data: {
          scheduleId: schedule.id,
          runId: spec.runId,
          scenario: schedule.scenario,
          models: schedule.models,
          status: 'started',
        },
      }, scheduleLogger);
    }
  } catch (err) {
    scheduleLogger?.error('Scheduled run failed to start', { 
      scheduleId: schedule.id, 
      error: String(err) 
    });
  }
}

function scheduleJob(schedule: Schedule, logger?: Logger): void {
  const nextRun = msUntilNextRun(schedule.cron);
  const scheduleLogger = logger?.child('scheduler');
  
  scheduleLogger?.info('Scheduling job', { 
    scheduleId: schedule.id, 
    nextRunMs: nextRun,
    nextRunTime: new Date(Date.now() + nextRun).toISOString(),
  });
  
  const timeout = setTimeout(() => {
    void executeSchedule(schedule, scheduleLogger);
    scheduleJob(schedule, logger);
  }, nextRun);
  
  scheduledJobs.set(schedule.id, timeout);
}

export function startScheduler(_rootDir: string, logger?: Logger): void {
  const scheduleLogger = logger?.child('scheduler');
  const schedules = getSchedules();
  
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (scheduledJobs.has(schedule.id)) continue;
    
    scheduleJob(schedule, scheduleLogger);
  }
}

export function stopScheduler(): void {
  for (const [, timeout] of scheduledJobs) {
    clearTimeout(timeout);
  }
  scheduledJobs.clear();
}

export function getSchedulerStatus(): Array<{ scheduleId: string; scheduled: boolean }> {
  return Array.from(scheduledJobs.keys()).map(id => ({
    scheduleId: id,
    scheduled: true,
  }));
}
