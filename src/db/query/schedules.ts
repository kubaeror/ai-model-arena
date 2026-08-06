import { eq, and, sql } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { schedules } from '../schema.js';
import type { DbSchedule } from '../schema.js';

// ── Schedules ─────────────────────────────────────────────────────────────

export async function listDueSchedules(now: string): Promise<DbSchedule[]> {
  const db = getDrizzleDb();
  return db.select().from(schedules)
    .where(and(eq(schedules.enabled, 1), sql`(${schedules.next_run} IS NULL OR ${schedules.next_run} <= ${now})`))
    .orderBy(schedules.next_run) as any;
}

export async function updateScheduleRun(id: string, lastRun: string, nextRun: string): Promise<void> {
  const db = getDrizzleDb();
  await db.update(schedules).set({ last_run: lastRun, next_run: nextRun }).where(eq(schedules.id, id));
}

export async function updateScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  const db = getDrizzleDb();
  await db.update(schedules).set({ enabled: enabled ? 1 : 0 }).where(eq(schedules.id, id));
}

export interface ScheduleInput {
  id: string;
  scenario: string;
  models: string[];
  cron: string;
  enabled: boolean;
  createdAt?: string;
}

export async function insertSchedule(s: ScheduleInput): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(schedules).values({
    id: s.id, scenario: s.scenario, models: JSON.stringify(s.models),
    cron: s.cron, enabled: s.enabled ? 1 : 0, created_at: s.createdAt ?? new Date().toISOString(),
  }).onConflictDoUpdate({
    target: schedules.id,
    set: {
      scenario: s.scenario,
      models: JSON.stringify(s.models),
      cron: s.cron,
      enabled: s.enabled ? 1 : 0,
    },
  });
}

export async function deleteSchedule(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(schedules).where(eq(schedules.id, id));
}

export async function listSchedules(): Promise<DbSchedule[]> {
  const db = getDrizzleDb();
  return db.select().from(schedules) as any;
}
