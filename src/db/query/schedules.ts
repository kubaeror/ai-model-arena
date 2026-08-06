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

export async function updateScheduleStatus(
  id: string,
  s: { lastStatus: string | null; lastError?: string | null; consecutiveFailures?: number; totalRuns?: number; totalFailures?: number },
): Promise<void> {
  const db = getDrizzleDb();
  await db.update(schedules).set({
    last_status: s.lastStatus,
    ...(s.lastError !== undefined ? { last_error: s.lastError } : {}),
    ...(s.consecutiveFailures !== undefined ? { consecutive_failures: s.consecutiveFailures } : {}),
    ...(s.totalRuns !== undefined ? { total_runs: s.totalRuns } : {}),
    ...(s.totalFailures !== undefined ? { total_failures: s.totalFailures } : {}),
  }).where(eq(schedules.id, id));
}

export async function getScheduleRow(id: string): Promise<DbSchedule | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(schedules).where(eq(schedules.id, id));
  return rows[0] ?? null;
}

interface ScheduleInput {
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
