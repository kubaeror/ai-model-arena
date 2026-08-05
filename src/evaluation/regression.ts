import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { outputRoot, findProjectRoot } from '../paths.js';
import type { Logger } from '../types.js';
import type { BaselineSnapshot, RegressionResult, JudgeResult } from './types.js';
import type { RunResult } from '../logger/result-logger.js';
import { readJudgeResult } from './judge.js';

async function notifyRegressionFailed(
  suite: string,
  model: string,
  regressions: RegressionResult['regressions'],
  logger?: Logger
): Promise<void> {
  try {
    const { loadNotificationConfig, dispatchNotification, DispatchEventType } = await import('../notifications/index.js');
    loadNotificationConfig(path.join(findProjectRoot(), 'configs', 'notifications.yaml'), logger);
    await dispatchNotification({
      type: DispatchEventType.onRegressionFailed,
      data: { suite, model, regressions },
      timestamp: new Date().toISOString(),
    }, logger);
  } catch (err) {
    logger?.warn('Regression notification dispatch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getBaselinePath(baselineDir: string, model: string, scenario: string): string {
  return path.join(baselineDir, model, `${scenario}.json`);
}

export function loadBaselineSnapshot(baselinePath: string): BaselineSnapshot | null {
  if (!fs.existsSync(baselinePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as BaselineSnapshot;
  } catch {
    return null;
  }
}

export function saveBaselineSnapshot(
  baselinePath: string,
  baseline: BaselineSnapshot,
  logger?: Logger
): void {
  const dir = path.dirname(baselinePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  logger?.info('Saved baseline snapshot', { path: baselinePath });
}

export function createBaselineSnapshot(
  result: RunResult,
  judgeResult: JudgeResult | null
): BaselineSnapshot | null {
  if (!judgeResult) return null;
  return {
    runId: result.runId,
    model: result.model,
    scenario: result.scenario,
    timestamp: result.finishedAt,
    metrics: {
      averageScore: judgeResult.averageScore,
      totalTokens: (result.tokenUsage.prompt ?? 0) + (result.tokenUsage.completion ?? 0),
      durationMs: result.durationMs,
      success: result.success,
    },
  };
}

/**
 * Relative change from baseline, guarded against division by zero.
 * Returns 0 when the baseline is zero (no sane percentage exists) instead of
 * +∞ or a fabricated ratio.
 */
function relativeChange(current: number, baseline: number): number {
  return baseline > 0 ? (current - baseline) / baseline : 0;
}

export function compareBaseline(
  current: RunResult,
  baseline: BaselineSnapshot,
  judgeResult: JudgeResult | null,
  thresholds: { scoreDrop: number; tokenIncrease: number; timeIncrease: number }
): RegressionResult {
  const currentMetrics = {
    averageScore: judgeResult?.averageScore ?? 0,
    totalTokens: (current.tokenUsage.prompt ?? 0) + (current.tokenUsage.completion ?? 0),
    durationMs: current.durationMs,
  };
  
  const regressions: RegressionResult['regressions'] = [];
  
  if (baseline.metrics.averageScore > 0) {
    const drop = baseline.metrics.averageScore - currentMetrics.averageScore;
    if (drop > thresholds.scoreDrop) {
      regressions.push({
        metric: 'averageScore',
        baseline: baseline.metrics.averageScore,
        current: currentMetrics.averageScore,
        change: drop,
        threshold: thresholds.scoreDrop,
      });
    }
  }
  
  const tokenIncrease = relativeChange(currentMetrics.totalTokens, baseline.metrics.totalTokens);
  if (tokenIncrease > thresholds.tokenIncrease) {
    regressions.push({
      metric: 'totalTokens',
      baseline: baseline.metrics.totalTokens,
      current: currentMetrics.totalTokens,
      change: tokenIncrease,
      threshold: thresholds.tokenIncrease,
    });
  }
  
  const timeIncrease = relativeChange(currentMetrics.durationMs, baseline.metrics.durationMs);
  if (timeIncrease > thresholds.timeIncrease) {
    regressions.push({
      metric: 'durationMs',
      baseline: baseline.metrics.durationMs,
      current: currentMetrics.durationMs,
      change: timeIncrease,
      threshold: thresholds.timeIncrease,
    });
  }
  
  return {
    passed: regressions.length === 0,
    regressions,
  };
}

export interface SuiteResult {
  suite: string;
  runId: string;
  model: string;
  scenarioResults: Array<{
    scenario: string;
    success: boolean;
    regression?: RegressionResult;
    baseline?: BaselineSnapshot;
    current: RunResult;
    judge?: JudgeResult | null;
  }>;
  passed: boolean;
  timestamp: string;
}

/**
 * On-disk convention for saved suite results:
 * <OUTPUT_ROOT>/regression/<suite>/regression-results.json
 *
 * One file per suite, overwritten on each run of that suite. Callers of
 * runRegressionSuite (CLI `regress` command, dashboard POST /api/regression)
 * call saveSuiteResult() so past runs stay browsable via GET
 * /api/regression/results.
 */
export function regressionResultsDir(): string {
  return path.join(outputRoot(), 'regression');
}

function suiteDirName(suite: string): string {
  return suite.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'unnamed';
}

export function saveSuiteResult(result: SuiteResult, logger?: Logger): void {
  const dir = path.join(regressionResultsDir(), suiteDirName(result.suite));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'regression-results.json');
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  logger?.info('Saved regression suite result', { suite: result.suite, runId: result.runId, path: filePath });
}

/**
 * Read the newest `limit` saved results across all suites, newest first.
 * Corrupt or malformed files are skipped. `limit` is clamped to [1, 100].
 */
export function listSavedSuiteResults(limit = 10): SuiteResult[] {
  const clamped = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const root = regressionResultsDir();
  if (!fs.existsSync(root)) return [];
  const results: SuiteResult[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, 'regression-results.json');
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SuiteResult;
      if (
        typeof parsed.suite === 'string' &&
        typeof parsed.runId === 'string' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.passed === 'boolean' &&
        Array.isArray(parsed.scenarioResults)
      ) {
        results.push(parsed);
      }
    } catch {
      // skip corrupt result files
    }
  }
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return results.slice(0, clamped);
}

export async function runRegressionSuite(
  suiteName: string,
  models: string[],
  scenarios: string[],
  baselineDir: string,
  thresholds: { scoreDrop: number; tokenIncrease: number; timeIncrease: number },
  getCurrentRunResult: (model: string, scenario: string) => Promise<RunResult | null>,
  logger?: Logger
): Promise<SuiteResult> {
  const suiteResult: SuiteResult = {
    suite: suiteName,
    runId: `regress-${randomUUID()}`,
    model: models.join(','),
    scenarioResults: [],
    passed: true,
    timestamp: new Date().toISOString(),
  };
  
  for (const model of models) {
    for (const scenario of scenarios) {
      const currentResult = await getCurrentRunResult(model, scenario);
      if (!currentResult) {
        logger?.warn('No current result for regression check', { model, scenario });
        continue;
      }
      
      const outputDir = path.join(outputRoot(), model, currentResult.runId);
      const baselinePath = getBaselinePath(baselineDir, model, scenario);
      const baseline = loadBaselineSnapshot(baselinePath);
      
      const judgeResult = readJudgeResult(outputDir);
      
      const resultEntry: SuiteResult['scenarioResults'][number] = {
        scenario,
        success: currentResult.success,
        current: currentResult,
        judge: judgeResult,
      };
      
      if (baseline && currentResult.success) {
        const regression = compareBaseline(currentResult, baseline, judgeResult, thresholds);
        resultEntry.regression = regression;
        resultEntry.baseline = baseline;
        
        if (!regression.passed) {
          suiteResult.passed = false;
          logger?.warn('Regression detected', { model, scenario, regressions: regression.regressions });
          void notifyRegressionFailed(suiteName, model, regression.regressions, logger);
        }
      }
      
      suiteResult.scenarioResults.push(resultEntry);
    }
  }
  
  return suiteResult;
}
