import type { TraceMeta, SpanMeta } from '../observability/trace-meta.js';
import { readJudgeResult } from '../evaluation/judge.js';
import type { RunResult } from '../logger/result-logger.js';
import type { AnomalyDetectionConfig } from './config.js';
import type { RunHistory } from './baselines.js';
import { latencyStats, tokenStats, costStats, errorRateStats, readResult } from './baselines.js';
import type { NewAnomaly, AnomalySeverity } from './db.js';
import type { ToolCallEntry } from '../logger/conversation-parser.js';
import { detectLoops } from '../logger/conversation-parser.js';
import { createLogger } from '../logger/pino-logger.js';

const logger = createLogger('ai-arena:anomaly');

export type ToolCallRow = ToolCallEntry;

export interface RunAnalysisInput {
  runId: string;
  model: string;
  scenario: string;
  outputDir: string;
  result: RunResult | null;
  trace: TraceMeta | null;
  toolCalls: ToolCallRow[];
  judgeScore: number | null;
}

export type Detector = (input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory) => NewAnomaly[];

/** Read the judge score (0-100) for a run, if judge_score.json exists. */
export function readJudgeScore(outputDir: string): number | null {
  const r = readJudgeResult(outputDir);
  return r ? r.averageScore : null;
}

// ── Latency ──────────────────────────────────────────────────────────────────

export function latencyDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.latency;
  if (!cfg.enabled || !input.trace) return [];
  const out: NewAnomaly[] = [];
  const spans = input.trace.spans.filter((s): s is SpanMeta & { durationMs: number } =>
    (s.type === 'execute_tool' || s.type === 'chat') && typeof s.durationMs === 'number');
  for (const span of spans) {
    const tool = String(span.attributes['gen_ai.tool.name'] ?? span.name);
    const key = span.type === 'execute_tool' ? tool : `chat:${input.model}`;
    const stats = latencyStats(history, input.model, key);
    if (stats.count < config.minSampleSize || stats.std === 0) {
      logger.warn('Latency detection disabled: insufficient baseline', { model: input.model, tool: key, sampleCount: stats.count, std: stats.std });
      continue;
    }
    const z = (span.durationMs - stats.mean) / stats.std;
    if (z >= cfg.zScoreThreshold) {
      out.push({
        run_id: input.runId,
        model: input.model,
        type: 'latency',
        severity: cfg.severity as AnomalySeverity,
        description: `${key} call took ${span.durationMs}ms (z-score ${z.toFixed(2)}, baseline mean ${stats.mean.toFixed(0)}ms over ${stats.count} runs)`,
        metadata: { spanId: span.spanId, tool: key, durationMs: span.durationMs, baselineMean: stats.mean, baselineStd: stats.std, zScore: Number(z.toFixed(2)) },
      });
    }
  }
  return out;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

export function loopDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig): NewAnomaly[] {
  const cfg = config.loop;
  if (!cfg.enabled) return [];
  const found = detectLoops(input.toolCalls, cfg.consecutiveRepeats);
  if (found) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'loop',
      severity: cfg.severity as AnomalySeverity,
      description: `Tool "${found.tool}" with identical arguments repeated ${found.consecutive} times consecutively (turn ${found.turns[0] ?? 'n/a'})`,
      metadata: { tool: found.tool, consecutive: found.consecutive, turn: found.turns[0] ?? null },
    }];
  }
  return [];
}

// ── Token spike ───────────────────────────────────────────────────────────────

export function tokenSpikeDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.tokenSpike;
  if (!cfg.enabled || !input.result) return [];
  const total = (input.result.tokenUsage.prompt ?? 0) + (input.result.tokenUsage.completion ?? 0);
  const stats = tokenStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize) {
    logger.warn('Token-spike detection disabled: insufficient baseline', { model: input.model, scenario: input.scenario, sampleCount: stats.count });
    return [];
  }
  const threshold = stats.mean * cfg.multiple;
  if (total > threshold) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'token_spike',
      severity: cfg.severity as AnomalySeverity,
      description: `Total tokens ${total} exceeded ${cfg.multiple}x historical mean (${stats.mean.toFixed(0)} over ${stats.count} runs)`,
      metadata: { totalTokens: total, baselineMean: stats.mean, multiple: cfg.multiple, sampleCount: stats.count },
    }];
  }
  return [];
}

// ── Cost spike ────────────────────────────────────────────────────────────────

export function costSpikeDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.costSpike;
  if (!cfg.enabled || !input.result || input.result.costUsd == null) return [];
  const cost = input.result.costUsd;
  const stats = costStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize || stats.mean === 0) {
    logger.warn('Cost-spike detection disabled: insufficient baseline', { model: input.model, scenario: input.scenario, sampleCount: stats.count, mean: stats.mean });
    return [];
  }
  const threshold = stats.mean * cfg.multiple;
  if (cost > threshold) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'cost_spike',
      severity: cfg.severity as AnomalySeverity,
      description: `Cost ${cost.toFixed(4)} exceeded ${cfg.multiple}x historical mean (${stats.mean.toFixed(4)} over ${stats.count} runs)`,
      metadata: { costUsd: cost, baselineMean: stats.mean, multiple: cfg.multiple, sampleCount: stats.count },
    }];
  }
  return [];
}

// ── Error rate ────────────────────────────────────────────────────────────────

export function errorRateDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.errorRate;
  if (!cfg.enabled || !input.result) return [];
  const totalToolCalls = input.result.totalToolCalls;
  const errorCount = input.trace ? input.trace.errorCount : (input.result.errors?.length ?? 0);
  const frac = totalToolCalls > 0 ? errorCount / totalToolCalls : (errorCount > 0 ? 1 : 0);
  const stats = errorRateStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize || stats.std === 0) {
    logger.warn('Error-rate detection disabled: insufficient baseline', { model: input.model, scenario: input.scenario, sampleCount: stats.count, std: stats.std });
    return [];
  }
  const z = (frac - stats.mean) / stats.std;
  if (z >= cfg.zScoreThreshold && frac > stats.mean) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'error_rate',
      severity: cfg.severity as AnomalySeverity,
      description: `Error rate ${(frac * 100).toFixed(1)}% (z-score ${z.toFixed(2)}, baseline ${(stats.mean * 100).toFixed(1)}% over ${stats.count} runs)`,
      metadata: { errorRate: frac, errorCount, totalToolCalls, baselineMean: stats.mean, baselineStd: stats.std, zScore: Number(z.toFixed(2)) },
    }];
  }
  return [];
}

// ── Silent failure (criteria mismatch) ────────────────────────────────────────

export function silentFailureDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig): NewAnomaly[] {
  const cfg = config.silentFailure;
  if (!cfg.enabled || !input.result || input.judgeScore == null) return [];
  const success = input.result.success;
  if (success && input.judgeScore < cfg.lowJudgeScore) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'silent_failure',
      severity: cfg.severity as AnomalySeverity,
      description: `Criteria mismatch: success criteria passed but judge score ${input.judgeScore} is unusually low (below ${cfg.lowJudgeScore})`,
      metadata: { success: true, judgeScore: input.judgeScore, lowThreshold: cfg.lowJudgeScore },
    }];
  }
  if (!success && input.judgeScore > cfg.highJudgeScore) {
    return [{
      run_id: input.runId,
      model: input.model,
      type: 'silent_failure',
      severity: cfg.severity as AnomalySeverity,
      description: `Criteria mismatch: success criteria failed but judge score ${input.judgeScore} is unusually high (above ${cfg.highJudgeScore})`,
      metadata: { success: false, judgeScore: input.judgeScore, highThreshold: cfg.highJudgeScore },
    }];
  }
  return [];
}

export const ALL_DETECTORS: Detector[] = [
  latencyDetector,
  loopDetector,
  tokenSpikeDetector,
  costSpikeDetector,
  errorRateDetector,
  silentFailureDetector,
];

export { readResult };
