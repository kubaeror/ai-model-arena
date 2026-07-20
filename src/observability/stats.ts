import { loadRunIndex } from '../orchestrator/run-index.js';
import { readTraceMeta, type TraceMeta, type SpanMeta } from './trace-meta.js';
import { readResult } from '../anomaly-detection/baselines.js';
import { anomalyCountsByModel } from '../anomaly-detection/db.js';

/**
 * Aggregated observability statistics computed by scanning stored run data +
 * trace metadata. Backs the `GET /api/v1/observability/stats` endpoint: avg,
 * p95, p99 latency per model/tool, error rates, and rolling token/cost
 * baselines (the same baselines anomaly detection thresholds are tuned
 * against).
 */

export interface LatencyStat {
  model: string;
  tool: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ModelStat {
  model: string;
  runs: number;
  errorRate: number;
  anomalies: number;
  unresolvedAnomalies: number;
}

export interface ScenarioBaseline {
  model: string;
  scenario: string;
  sampleCount: number;
  avgTokens: number;
  avgCostUsd: number;
}

export interface ObservabilityStats {
  generatedAt: string;
  latency: LatencyStat[];
  models: ModelStat[];
  baselines: ScenarioBaseline[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeObservabilityStats(modelFilter?: string): ObservabilityStats {
  const idx = loadRunIndex();
  const latencyBy = new Map<string, number[]>(); // `${model}|${tool}` -> durations
  const modelRuns = new Map<string, number>();
  const modelErrors = new Map<string, number>();
  const tokensBy = new Map<string, number[]>(); // `${model}|${scenario}`
  const costsBy = new Map<string, number[]>();

  for (const run of idx.runs) {
    for (const pm of run.perModel) {
      if (modelFilter && pm.model !== modelFilter) continue;
      modelRuns.set(pm.model, (modelRuns.get(pm.model) ?? 0) + 1);
      const result = readResult(pm.resultPath);
      if (result) {
        const tokens = ((result.tokenUsage as Record<string, number> | undefined)?.prompt ?? 0) + ((result.tokenUsage as Record<string, number> | undefined)?.completion ?? 0);
        const arr = tokensBy.get(`${pm.model}|${run.scenario}`) ?? [];
        arr.push(tokens);
        tokensBy.set(`${pm.model}|${run.scenario}`, arr);
        const costArr = costsBy.get(`${pm.model}|${run.scenario}`) ?? [];
        costArr.push(Number(result.costUsd ?? 0));
        costsBy.set(`${pm.model}|${run.scenario}`, costArr);
        const errs = Array.isArray(result.errors) ? result.errors.length : 0;
        if (errs > 0) modelErrors.set(pm.model, (modelErrors.get(pm.model) ?? 0) + 1);
        void result.success;
      }
      const meta: TraceMeta | null = readTraceMeta(pm.outputDir);
      if (meta) {
        for (const s of meta.spans) {
          if ((s.type === 'execute_tool' || s.type === 'chat') && typeof s.durationMs === 'number') {
            const tool = s.type === 'execute_tool' ? String(s.attributes['gen_ai.tool.name'] ?? s.name) : `chat:${pm.model}`;
            const key = `${pm.model}|${tool}`;
            const arr = latencyBy.get(key) ?? [];
            arr.push(s.durationMs);
            latencyBy.set(key, arr);
          }
        }
      }
    }
  }

  const latency: LatencyStat[] = [];
  for (const [key, arr] of latencyBy) {
    const [model, tool] = key.split('|');
    const sorted = [...arr].sort((a, b) => a - b);
    latency.push({
      model: model ?? '', tool: tool ?? '',
      count: arr.length,
      avgMs: arr.reduce((a, b) => a + b, 0) / arr.length,
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    });
  }
  latency.sort((a, b) => b.count - a.count);

  let anomalyCounts: Array<{ model: string; total: number; unresolved: number }> = [];
  try { anomalyCounts = anomalyCountsByModel(); } catch { /* DB unavailable */ }
  const models: ModelStat[] = [...modelRuns.entries()].map(([model, runs]) => {
    const ac = anomalyCounts.find((a) => a.model === model);
    return {
      model,
      runs,
      errorRate: runs > 0 ? (modelErrors.get(model) ?? 0) / runs : 0,
      anomalies: ac?.total ?? 0,
      unresolvedAnomalies: ac?.unresolved ?? 0,
    };
  });

  const baselines: ScenarioBaseline[] = [];
  for (const [key, arr] of tokensBy) {
    const [model, scenario] = key.split('|');
    const costs = costsBy.get(key) ?? [];
    baselines.push({
      model: model ?? '', scenario: scenario ?? '',
      sampleCount: arr.length,
      avgTokens: arr.reduce((a, b) => a + b, 0) / arr.length,
      avgCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
    });
  }

  return { generatedAt: new Date().toISOString(), latency, models, baselines };
}

export type { SpanMeta };
