import fs from 'node:fs';
import { loadRunIndex, type RunIndexRecord, type RunIndexModelEntry } from '../orchestrator/run-index.js';
import { readTraceMeta, type TraceMeta, type SpanMeta } from '../observability/trace-meta.js';

/**
 * Rolling statistics (mean + standard deviation) computed from stored run
 * data, used as the baseline for z-score-based anomaly detection. Stats are
 * scoped per (model, tool) for latency and per (model, scenario) for
 * token/cost, over the most recent `slidingWindow` runs (excluding the run
 * currently being analysed).
 */

export interface Stats {
  mean: number;
  std: number;
  count: number;
}

export interface RunHistory {
  toolLatency: Map<string, number[]>; // `${model}|${tool}` -> durations ms
  tokenTotals: Map<string, number[]>; // `${model}|${scenario}` -> total tokens
  costs: Map<string, number[]>; // `${model}|${scenario}` -> cost usd
  toolErrorRates: Map<string, number[]>; // `${model}` -> failure fraction per run
  durations: Map<string, number[]>; // `${model}|${scenario}` -> run duration ms
}

function readResult(resultPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function totalTokens(result: Record<string, unknown>): number {
  const usage = result.tokenUsage as Record<string, number> | undefined;
  return (usage?.prompt ?? 0) + (usage?.completion ?? 0);
}

function spanLatencies(meta: TraceMeta | null): Array<{ tool: string; durationMs: number }> {
  if (!meta) return [];
  const out: Array<{ tool: string; durationMs: number }> = [];
  for (const s of meta.spans) {
    if (s.type === 'execute_tool' && s.durationMs != null) {
      const tool = String(s.attributes['gen_ai.tool.name'] ?? s.name);
      out.push({ tool, durationMs: s.durationMs });
    }
  }
  return out;
}

/** Push a value into a Map<string, number[]>, capping at `window` entries. */
function pushCapped(map: Map<string, number[]>, key: string, value: number, window: number): void {
  const arr = map.get(key) ?? [];
  arr.push(value);
  if (arr.length > window) arr.shift();
  map.set(key, arr);
}

function computeStats(arr: number[]): Stats {
  if (arr.length === 0) return { mean: 0, std: 0, count: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (arr.length < 2) return { mean, std: 0, count: arr.length };
  const variance = arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (arr.length - 1);
  return { mean, std: Math.sqrt(variance), count: arr.length };
}

/** Build a `RunHistory` over recent runs (excluding `excludeRunId`). */
export function buildRunHistory(
  model: string,
  scenario: string,
  slidingWindow: number,
  excludeRunId?: string,
): RunHistory {
  const idx = loadRunIndex();
  // Newest first, then take the window.
  const runs = idx.runs
    .filter((r) => r.runId !== excludeRunId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  const toolLatency = new Map<string, number[]>();
  const tokenTotals = new Map<string, number[]>();
  const costs = new Map<string, number[]>();
  const toolErrorRates = new Map<string, number[]>();
  const durations = new Map<string, number[]>();

  let taken = 0;
  for (const run of runs) {
    if (taken >= slidingWindow) break;
    const perModel = run.perModel.find((m) => m.model === model);
    if (!perModel) continue;
    const result = readResult(perModel.resultPath);
    if (!result) continue;
    // Only count completed runs toward history.
    if (result.success === undefined && perModel.status !== 'completed') continue;
    taken++;

    const tokens = totalTokens(result);
    const cost = Number(result.costUsd ?? 0);
    const durationMs = Number(result.durationMs ?? 0);
    pushCapped(tokenTotals, `${model}|${run.scenario}`, tokens, slidingWindow);
    pushCapped(costs, `${model}|${run.scenario}`, cost, slidingWindow);
    pushCapped(durations, `${model}|${run.scenario}`, durationMs, slidingWindow);

    // Tool latency + error rate from trace metadata (if present).
    const meta = readTraceMeta(perModel.outputDir);
    const latencies = spanLatencies(meta);
    for (const l of latencies) {
      pushCapped(toolLatency, `${model}|${l.tool}`, l.durationMs, slidingWindow);
    }
    // Failure fraction for this run (from result errors + trace error spans).
    const totalToolCalls = Number(result.totalToolCalls ?? 0);
    const errorCount = meta ? meta.errorCount : (Array.isArray(result.errors) ? (result.errors as unknown[]).length : 0);
    const frac = totalToolCalls > 0 ? errorCount / totalToolCalls : (errorCount > 0 ? 1 : 0);
    pushCapped(toolErrorRates, `${model}|${run.scenario}`, frac, slidingWindow);
    void scenario;
  }

  return { toolLatency, tokenTotals, costs, toolErrorRates, durations };
}

export function latencyStats(history: RunHistory, model: string, tool: string): Stats {
  return computeStats(history.toolLatency.get(`${model}|${tool}`) ?? []);
}

export function tokenStats(history: RunHistory, model: string, scenario: string): Stats {
  return computeStats(history.tokenTotals.get(`${model}|${scenario}`) ?? []);
}

export function costStats(history: RunHistory, model: string, scenario: string): Stats {
  return computeStats(history.costs.get(`${model}|${scenario}`) ?? []);
}

export function errorRateStats(history: RunHistory, model: string, scenario: string): Stats {
  return computeStats(history.toolErrorRates.get(`${model}|${scenario}`) ?? []);
}

export function durationStats(history: RunHistory, model: string, scenario: string): Stats {
  return computeStats(history.durations.get(`${model}|${scenario}`) ?? []);
}

/** Expose for the observability stats endpoint. */
export { computeStats, readResult, totalTokens };
export type { RunIndexRecord, RunIndexModelEntry, SpanMeta };
