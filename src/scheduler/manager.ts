import fs from 'node:fs';
import path from 'node:path';
import { load, dump } from 'js-yaml';
import type { Logger } from '../types.js';
import type { Schedule, SchedulesConfig, ScheduleState } from './types.js';
import { SchedulesConfigSchema } from './types.js';

let schedulesConfig: SchedulesConfig | null = null;
const scheduleStates = new Map<string, ScheduleState>();
let _schedulerStarted = false;
void _schedulerStarted;

export function loadSchedulesConfig(configPath: string, logger?: Logger): SchedulesConfig {
  if (schedulesConfig) return schedulesConfig;
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = SchedulesConfigSchema.parse({ schedules: [] });
    logger?.warn(`Schedules config not found at ${resolvedPath}, no scheduled jobs`);
    schedulesConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = load(content);
  const validated = SchedulesConfigSchema.parse(parsed);
  schedulesConfig = validated;
  
  for (const schedule of validated.schedules) {
    scheduleStates.set(schedule.id, { id: schedule.id, status: 'idle', consecutiveFailures: 0, totalRuns: 0, totalFailures: 0 });
  }
  
  return validated;
}

export function getSchedules(): Schedule[] {
  return schedulesConfig?.schedules ?? [];
}

export function getSchedule(id: string): Schedule | undefined {
  return schedulesConfig?.schedules.find(s => s.id === id);
}

export function getScheduleState(id: string): ScheduleState | undefined {
  return scheduleStates.get(id);
}

export function getAllScheduleStates(): ScheduleState[] {
  return Array.from(scheduleStates.values());
}

export function updateScheduleState(id: string, update: Partial<ScheduleState>): void {
  const current = scheduleStates.get(id) ?? { id, status: 'idle' as const, consecutiveFailures: 0, totalRuns: 0, totalFailures: 0 };
  scheduleStates.set(id, { ...current, ...update });
}

export function addSchedule(configPath: string, schedule: Schedule, logger?: Logger): void {
  const config = loadSchedulesConfig(configPath, logger);
  const existing = config.schedules.find(s => s.id === schedule.id);
  if (existing) {
    throw new Error(`Schedule with id "${schedule.id}" already exists`);
  }
  config.schedules.push(schedule);
  
  const resolvedPath = path.resolve(configPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, dump(config));
  scheduleStates.set(schedule.id, { id: schedule.id, status: 'idle', consecutiveFailures: 0, totalRuns: 0, totalFailures: 0 });
}

export function removeSchedule(configPath: string, id: string, logger?: Logger): boolean {
  const config = loadSchedulesConfig(configPath, logger);
  const index = config.schedules.findIndex(s => s.id === id);
  if (index === -1) return false;
  
  config.schedules.splice(index, 1);
  
  const resolvedPath = path.resolve(configPath);
  fs.writeFileSync(resolvedPath, dump(config));
  scheduleStates.delete(id);
  
  return true;
}

export function resetSchedulesCache(): void {
  schedulesConfig = null;
  scheduleStates.clear();
  _schedulerStarted = false;
}
