import { Router } from 'express';
import path from 'node:path';
import { requireRole } from '../../auth/rbac.js';
import { findProjectRoot } from '../../paths.js';
import {
  loadSchedulesConfig,
  getSchedules,
  getSchedule,
  getScheduleState,
  addSchedule,
  removeSchedule,
  setScheduleEnabled,
} from '../../scheduler/manager.js';
import { listSchedules, getScheduleRow } from '../../db/query.js';
import type { DbSchedule } from '../../db/schema.js';
import { createLogger } from '../../logger/pino-logger.js';

function configPath(): string {
  return path.join(findProjectRoot(), 'configs', 'schedules.yaml');
}

function stateFromRow(row: DbSchedule | null | undefined) {
  return row ? {
    id: row.id,
    status: row.last_status ?? 'idle',
    lastRun: row.last_run ?? null,
    nextRun: row.next_run ?? null,
    lastError: row.last_error ?? null,
    consecutiveFailures: row.consecutive_failures,
    totalRuns: row.total_runs,
    totalFailures: row.total_failures,
  } : null;
}

export function createSchedulesRouter(): Router {
  const router = Router();
  const logger = createLogger('ai-arena:routes:schedules');

  loadSchedulesConfig(configPath(), logger);

  router.get('/', async (_req, res) => {
    const schedules = getSchedules();
    const rows = await listSchedules();
    const merged = schedules.map((s) => {
      const row = rows.find((r) => r.id === s.id);
      return { ...s, state: stateFromRow(row) };
    });
    res.json({ schedules: merged });
  });

  router.get('/:id', async (req, res) => {
    const schedule = getSchedule(req.params.id as string);
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const row = await getScheduleRow(req.params.id as string);
    res.json({ ...schedule, state: stateFromRow(row) });
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const { id, scenario, models, cron, enabled, options } = req.body ?? {};
    if (!scenario || !Array.isArray(models) || !cron) {
      res.status(400).json({ error: 'scenario (string), models (string[]), and cron (string) are required' });
      return;
    }
    try {
      const scheduleId = id || `schedule-${Date.now()}`;
      await addSchedule(configPath(), {
        id: scheduleId,
        scenario: String(scenario),
        models: models.filter((m: unknown): m is string => typeof m === 'string'),
        cron: String(cron),
        enabled: enabled !== false,
        options,
      }, logger);
      res.status(201).json({ id: scheduleId });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    const schedule = getSchedule(req.params.id as string);
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const ok = await setScheduleEnabled(configPath(), req.params.id as string, enabled, logger);
    if (!ok) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const updated = getSchedule(req.params.id as string)!;
    res.json({ ...updated, state: getScheduleState(req.params.id as string) ?? null });
  });

  router.delete('/:id', requireRole('admin'), async (req, res) => {
    const ok = await removeSchedule(configPath(), req.params.id as string, logger);
    if (!ok) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ deleted: req.params.id as string });
  });

  return router;
}
