import type { Logger } from '../../types.js';
import { releaseReservation } from '../../cost-tracking/index.js';
import type { ComparisonEntry } from '../../logger/comparison-logger.js';

/** Per-run budget reservations (runId -> model -> reserved USD). */
const runReservations = new Map<string, Map<string, number>>();

/** Record reservations made at startRun time for a run. */
export function recordRunReservations(runId: string, reservations: Array<{ model: string; estimated: number }>): void {
  runReservations.set(runId, new Map(reservations.map((r) => [r.model, r.estimated])));
}

/**
 * Release budget reservations with actual costs (from FAT.min ledger costs).
 * Releasing the exact reserved amount keeps pendingReservations accurate —
 * a fabricated estimate leaked the remainder and eventually blocked all runs.
 */
export function releaseRunReservations(
  runId: string,
  entries: ComparisonEntry[],
  budgetStateRoot: string,
  logger: Logger,
): void {
  const reservations = runReservations.get(runId) ?? new Map<string, number>();
  for (const entry of entries) {
    const actualCost = entry.result?.costUsd ?? 0;
    const reserved = reservations.get(entry.model) ?? 0;
    releaseReservation(entry.model, reserved, actualCost, budgetStateRoot, logger);
  }
  runReservations.delete(runId);
}
