export interface RunLimits {
  maxExecutionSec: number;
  maxCostUsd: number;
}

export interface RunLimitState {
  elapsedMs: number;
  runCostUsd: number;
}

export type RunLimitStopReason = 'max_execution_time_exceeded' | 'max_cost_exceeded';

/**
 * Wall-clock budget anchor: prefer the session's creation time — sessions are
 * created at first dequeue with a deterministic id (`${runId}-${model}`), so
 * this marks the run's first execution per model. Queue wait and sibling-model
 * runtime do not count toward the cap, while nack retries and runner restarts
 * cannot reset it. A missing/unparseable session falls back to this attempt's
 * start, so direct enqueues still get a budget.
 */
export function resolveExecutionStartMs(
  sessionCreatedAt: string | null | undefined,
  attemptStartedAtMs: number,
): number {
  const parsed = sessionCreatedAt ? Date.parse(sessionCreatedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : attemptStartedAtMs;
}

/** A limit of 0 means unlimited; a limit trips only once strictly exceeded. */
export function evaluateRunLimits(limits: RunLimits, state: RunLimitState): RunLimitStopReason | null {
  if (limits.maxExecutionSec > 0 && state.elapsedMs > limits.maxExecutionSec * 1000) {
    return 'max_execution_time_exceeded';
  }
  if (limits.maxCostUsd > 0 && state.runCostUsd > limits.maxCostUsd) {
    return 'max_cost_exceeded';
  }
  return null;
}
