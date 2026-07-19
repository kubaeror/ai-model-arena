import fs from 'node:fs';
import path from 'node:path';
import type { TokenUsage } from '../types.js';

/**
 * Structured per-run outcome. Written to `outputs/<model>/<runId>/result.json`
 * by the worker and aggregated by the orchestrator into a comparison report.
 */
export interface RunResult {
  model: string;
  scenario: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  turnsUsed: number;
  maxTurns: number;
  totalToolCalls: number;
  toolsCalled: { name: string; count: number }[];
  tokenUsage: TokenUsage;
  stopReason?: string;
  errors: string[];
  success: boolean;
  successCriteria?: {
    command?: string;
    expectedExitCode: number;
    exitCode?: number | null;
    output?: string;
    outputContainsPassed?: boolean;
    passed?: boolean;
  };
}

export function writeResultJson(filePath: string, result: RunResult): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
}

export function readResultJson(filePath: string): RunResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`result.json not found for run: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunResult;
}
