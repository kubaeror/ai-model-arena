import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../types.js';
import type { BaselineSnapshot, RegressionResult, JudgeResult } from './types.js';
import type { RunResult } from '../logger/result-logger.js';
import { readJudgeResult } from './judge.js';

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
): BaselineSnapshot {
  return {
    runId: result.runId,
    model: result.model,
    scenario: result.scenario,
    timestamp: result.finishedAt,
    metrics: {
      averageScore: judgeResult?.averageScore ?? 0,
      totalTokens: (result.tokenUsage.prompt ?? 0) + (result.tokenUsage.completion ?? 0),
      durationMs: result.durationMs,
      success: result.success,
    },
  };
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
  
  const tokenIncrease = (currentMetrics.totalTokens - baseline.metrics.totalTokens) / Math.max(baseline.metrics.totalTokens, 1);
  if (tokenIncrease > thresholds.tokenIncrease) {
    regressions.push({
      metric: 'totalTokens',
      baseline: baseline.metrics.totalTokens,
      current: currentMetrics.totalTokens,
      change: tokenIncrease,
      threshold: thresholds.tokenIncrease,
    });
  }
  
  const timeIncrease = (currentMetrics.durationMs - baseline.metrics.durationMs) / Math.max(baseline.metrics.durationMs, 1);
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
    runId: `regress-${Date.now()}`,
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
      
      const outputDir = path.join('outputs', model, currentResult.runId);
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
        }
      }
      
      suiteResult.scenarioResults.push(resultEntry);
    }
  }
  
  return suiteResult;
}
