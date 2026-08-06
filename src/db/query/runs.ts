import { eq, and } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { run_models } from '../schema.js';

// ── Runs ──────────────────────────────────────────────────────────────────

/**
 * Update the status + timestamp columns for a task in the run_models table.
 * Used for state machine transitions: pending → claimed → running → completed/failed/dead.
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

  // Drizzle update — works on both SQLite and Postgres dialects.
  await db.update(run_models).set(updates).where(
    and(eq(run_models.run_id, runId), eq(run_models.model, model)),
  );
}
