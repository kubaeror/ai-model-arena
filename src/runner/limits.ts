export interface RunLimits {
  maxExecutionSec: number;
  maxCostUsd: number;
}

export interface RunLimitState {
  elapsedMs: number;
  runCostUsd: number;
}

export type RunLimitStopReason = 'max_execution_time_exceeded' | 'max_cost_exceeded';

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
