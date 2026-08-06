import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../types.js';
import { writeComparison, type ComparisonEntry } from '../../logger/comparison-logger.js';
import { updateRun, type RunIndexRecord, type RunIndexModelEntry } from '../run-index.js';
import { outputRoot } from '../../paths.js';

interface AggregateInput {
  runId: string;
  scenario: string;
  startedAt: string;
  models: { model: string; resultPath: string }[];
}

/** Aggregate per-model results and write comparison md/json. */
export function aggregate(_root: string, input: AggregateInput): {
  entries: ComparisonEntry[];
  mdPath: string;
  jsonPath: string;
} {
  const entries: ComparisonEntry[] = input.models.map((m) => {
    try {
      const result = JSON.parse(fs.readFileSync(m.resultPath, 'utf8'));
      return { model: m.model, runId: input.runId, result, resultPath: m.resultPath };
    } catch {
      return {
        model: m.model, runId: input.runId, resultPath: m.resultPath,
        error: 'result.json missing or unreadable (worker may have crashed before writing it).',
      };
    }
  });
  const { mdPath, jsonPath } = writeComparison(
    path.join(outputRoot(), 'comparisons', input.runId),
    entries,
    { scenario: input.scenario, startedAt: input.startedAt, finishedAt: new Date().toISOString() },
  );
  return { entries, mdPath, jsonPath };
}

/** Patch the run index with final status + comparison paths after finalize. */
export async function patchIndexAfterFinalize(runId: string, mdPath: string, jsonPath: string, perModel: RunIndexModelEntry[]): Promise<void> {
  await updateRun(runId, (rec) => {
    rec.status = 'completed';
    rec.finishedAt = new Date().toISOString();
    rec.comparisonMdPath = mdPath;
    rec.comparisonJsonPath = jsonPath;
    for (const m of perModel) {
      const entry = rec.perModel.find((x) => x.model === m.model);
      if (entry) Object.assign(entry, m);
    }
  });
}

/**
 * Build per-model index entries, recording spend/cost-ledger for completed models.
 * Shared by the CLI (spec-based) and dashboard watcher (runId-based) paths.
 */
export async function buildPerModelEntries(
  runId: string,
  rec: RunIndexRecord,
  entries: ComparisonEntry[],
  logger: Logger,
): Promise<RunIndexModelEntry[]> {
  return Promise.all(rec.perModel.map(async (m) => {
    const r = entries.find((x) => x.model === m.model)?.result;
    const base = {
      model: m.model, runId, outputDir: m.outputDir,
      sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
      reportPath: m.reportPath, logFile: m.logFile,
    };
    if (!r) return { ...base, status: 'errored' as const };
    if (typeof r.costUsd === 'number' && r.costUsd > 0) {
      try {
        const { insertCostLedgerEntry } = await import('../../db/query.js');
        const tokens = r.tokenUsage ?? {};
        await insertCostLedgerEntry({
          runId, model: m.model, costUsd: r.costUsd,
          inputTokens: tokens.prompt ?? null,
          outputTokens: tokens.completion ?? null,
          cacheReadTokens: tokens.cacheReadTokens ?? null,
          totalTokens: tokens.total ?? null,
          pricingVersion: null,
          recordedAt: new Date().toISOString(),
        });
      } catch (e) {
        logger.warn('cost ledger write failed (non-fatal)', { runId, model: m.model, err: String(e) });
      }
    }
    return {
      ...base, status: 'completed', success: r.success, turnsUsed: r.turnsUsed,
      totalToolCalls: r.totalToolCalls, stopReason: r.stopReason, durationMs: r.durationMs,
    };
  }));
}
