import { Router } from 'express';
import path from 'node:path';
import { requireRole } from '../../auth/rbac.js';
import { findProjectRoot } from '../../paths.js';
import {
  loadSchedulesConfig,
  getSchedules,
  getSchedule,
  getScheduleState,
  getAllScheduleStates,
  addSchedule,
  removeSchedule,
  setScheduleEnabled,
} from '../../scheduler/manager.js';
import { createLogger } from '../../logger/pino-logger.js';

function configPath(): string {
  return path.join(findProjectRoot(), 'configs', 'schedules.yaml');
}

export function createSchedulesRouter(): Router {
  const router = Router();
  const logger = createLogger('ai-arena:routes:schedules');

  loadSchedulesConfig(configPath(), logger);

  router.get('/', (_req, res) => {
    const schedules = getSchedules();
    const states = getAllScheduleStates();
    const merged = schedules.map((s) => {
      const st = states.find((st) => st.id === s.id);
      return { ...s, state: st ?? null };
    });
    res.json({ schedules: merged });
  });

  router.get('/:id', (req, res) => {
    const schedule = getSchedule(req.params.id as string);
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    const state = getScheduleState(req.params.id as string);
    res.json({ ...schedule, state: state ?? null });
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
