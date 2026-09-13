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
 * Wall-clock budget anchor: prefer the persisted run start so retries and
 * dashboard restarts cannot reset the cap; direct enqueues without a run
 * record fall back to this attempt's start (queue wait then counts).
 */
export function resolveExecutionStartMs(
  persistedStartedAt: string | null | undefined,
  attemptStartedAtMs: number,
): number {
  const parsed = persistedStartedAt ? Date.parse(persistedStartedAt) : NaN;
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
