import { eq, and, notInArray } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { run_models } from '../schema.js';

// ── Runs ──────────────────────────────────────────────────────────────────

/**
 * Terminal states for a run_models row. Once terminal, a row may only be
 * rewritten to the same terminal status: retries re-enter through the
 * non-terminal 'claimed'/'running' transitions, and a mid-run stop must never
 * be flipped to 'completed' by the finishing runner.
 */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'stopped', 'dead', 'errored'] as const;

/**
 * Update the status + timestamp columns for a task in the run_models table.
 * Used for state machine transitions: pending → claimed → running → completed/failed/dead/stopped.
 */
export async function transitionTaskState(
  runId: string,
  model: string,
  newStatus: string,
  runnerId?: string,
): Promise<void> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const updates: Partial<typeof run_models.$inferInsert> = { status: newStatus };

  switch (newStatus) {
    case 'claimed':
      updates.claimed_at = now;
      if (runnerId) updates.runner_id = runnerId;
      break;
    case 'running':
      updates.started_at = now;
      break;
    case 'completed':
    case 'failed':
    case 'dead':
      updates.completed_at = now;
      break;
  }

  // Single conditional UPDATE so the terminal-status check is atomic on both
  // SQLite and Postgres: a row already holding a different terminal status
  // matches no rows and is left untouched.
  const terminalGuard = (TERMINAL_TASK_STATUSES as readonly string[]).includes(newStatus)
    ? notInArray(run_models.status, TERMINAL_TASK_STATUSES.filter((s) => s !== newStatus))
    : undefined;

  // Drizzle update — works on both SQLite and Postgres dialects.
  await db.update(run_models).set(updates).where(
    and(eq(run_models.run_id, runId), eq(run_models.model, model), terminalGuard),
  );
}
