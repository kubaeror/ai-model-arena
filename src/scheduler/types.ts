import { z } from 'zod';

export const ScheduleSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  models: z.array(z.string()).min(1),
  cron: z.string(),
  enabled: z.boolean().default(true),
  notifications: z.array(z.string()).optional(),
  options: z.object({
    forceBudget: z.boolean().optional(),
    timeoutMs: z.number().optional(),
  }).optional(),
});

export const SchedulesConfigSchema = z.object({
  schedules: z.array(ScheduleSchema),
});

export type Schedule = z.output<typeof ScheduleSchema>;
export type SchedulesConfig = z.output<typeof SchedulesConfigSchema>;

export type ScheduleId = string;

export interface ScheduleState {
  id: string;
  lastRun?: string;
  nextRun?: string;
  status: 'idle' | 'running' | 'error';
  lastError?: string;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
}
