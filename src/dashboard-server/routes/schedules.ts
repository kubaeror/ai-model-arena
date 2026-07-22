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

  router.post('/', requireRole('admin'), (req, res) => {
    const { id, scenario, models, cron, enabled, options } = req.body ?? {};
    if (!scenario || !Array.isArray(models) || !cron) {
      res.status(400).json({ error: 'scenario (string), models (string[]), and cron (string) are required' });
      return;
    }
    try {
      const scheduleId = id || `schedule-${Date.now()}`;
      addSchedule(configPath(), {
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

  router.delete('/:id', requireRole('admin'), (req, res) => {
    const ok = removeSchedule(configPath(), req.params.id as string, logger);
    if (!ok) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ deleted: req.params.id as string });
  });

  return router;
}
