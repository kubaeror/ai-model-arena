import fs from 'node:fs';
import path from 'node:path';
import type { TraceMeta, SpanMeta } from '../observability/trace-meta.js';
import type { RunResult } from '../logger/result-logger.js';
import type { AnomalyDetectionConfig } from './config.js';
import type { RunHistory } from './baselines.js';
import { latencyStats, tokenStats, costStats, errorRateStats, readResult } from './baselines.js';
import type { NewAnomaly, AnomalySeverity } from './db.js';
import type { ToolCallEntry } from '../logger/conversation-parser.js';

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
  const p = path.join(outputDir, 'judge_score.json');
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const score = data.score ?? data.judgeScore ?? data.totalScore;
    return typeof score === 'number' ? score : null;
  } catch {
    return null;
  }
}

// ── Latency ──────────────────────────────────────────────────────────────────

function latencyDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.latency;
  if (!cfg.enabled || !input.trace) return [];
  const out: NewAnomaly[] = [];
  const spans = input.trace.spans.filter((s): s is SpanMeta & { durationMs: number } =>
    (s.type === 'execute_tool' || s.type === 'chat') && typeof s.durationMs === 'number');
  for (const span of spans) {
    const tool = String(span.attributes['gen_ai.tool.name'] ?? span.name);
    const key = span.type === 'execute_tool' ? tool : `chat:${input.model}`;
    const stats = latencyStats(history, input.model, key);
    if (stats.count < config.minSampleSize || stats.std === 0) continue;
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

function loopDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig): NewAnomaly[] {
  const cfg = config.loop;
  if (!cfg.enabled) return [];
  const calls = input.toolCalls;
  const min = cfg.consecutiveRepeats;
  for (let i = 0; i <= calls.length - min; i++) {
    const c = calls[i]!;
    const key = `${c.name}:${JSON.stringify(c.arguments)}`;
    let consecutive = 1;
    for (let j = i + 1; j < calls.length; j++) {
      const cj = calls[j]!;
      const k2 = `${cj.name}:${JSON.stringify(cj.arguments)}`;
      if (k2 === key) consecutive++;
      else break;
    }
    if (consecutive >= min) {
      return [{
        run_id: input.runId,
        model: input.model,
        type: 'loop',
        severity: cfg.severity as AnomalySeverity,
        description: `Tool "${c.name}" with identical arguments repeated ${consecutive} times consecutively (turn ${c.turn})`,
        metadata: { tool: c.name, arguments: c.arguments, consecutive, turn: c.turn },
      }];
    }
  }
  return [];
}

// ── Token spike ───────────────────────────────────────────────────────────────

function tokenSpikeDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.tokenSpike;
  if (!cfg.enabled || !input.result) return [];
  const total = (input.result.tokenUsage.prompt ?? 0) + (input.result.tokenUsage.completion ?? 0);
  const stats = tokenStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize) return [];
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

function costSpikeDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.costSpike;
  if (!cfg.enabled || !input.result || input.result.costUsd == null) return [];
  const cost = input.result.costUsd;
  const stats = costStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize || stats.mean === 0) return [];
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

function errorRateDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig, history: RunHistory): NewAnomaly[] {
  const cfg = config.errorRate;
  if (!cfg.enabled || !input.result) return [];
  const totalToolCalls = input.result.totalToolCalls;
  const errorCount = input.trace ? input.trace.errorCount : (input.result.errors?.length ?? 0);
  const frac = totalToolCalls > 0 ? errorCount / totalToolCalls : (errorCount > 0 ? 1 : 0);
  const stats = errorRateStats(history, input.model, input.scenario);
  if (stats.count < config.minSampleSize || stats.std === 0) return [];
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

function silentFailureDetector(input: RunAnalysisInput, config: AnomalyDetectionConfig): NewAnomaly[] {
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
  (i, c, h) => latencyDetector(i, c, h),
  (i, c) => loopDetector(i, c),
  (i, c, h) => tokenSpikeDetector(i, c, h),
  (i, c, h) => costSpikeDetector(i, c, h),
  (i, c, h) => errorRateDetector(i, c, h),
  (i, c) => silentFailureDetector(i, c),
];

export { readResult };
