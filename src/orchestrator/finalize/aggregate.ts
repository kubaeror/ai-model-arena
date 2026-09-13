import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type { Logger } from '../../types.js';
import { writeComparison, type ComparisonEntry } from '../../logger/comparison-logger.js';
import { updateRun, type RunIndexRecord, type RunIndexModelEntry } from '../run-index.js';
import { outputRoot } from '../../paths.js';
import { getDrizzleDb } from '../../db/index.js';
import { runs } from '../../db/schema.js';

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

/**
 * How long a 'finalizing' claim is trusted before recovery may steal it. The
 * finalizer is a short in-process sequence (aggregate + ledger + index patch),
 * so a claim older than this is treated as a crashed finalizer.
 */
export const FINALIZE_STALE_MS = 2 * 60 * 1000;

/**
 * Atomically claim finalization of `runId`: one conditional UPDATE flips a
 * non-completed run to 'finalizing' and stamps `finished_at`. Exactly one
 * concurrent finalizer (runner self-finalize vs dashboard watcher vs CLI)
 * observes a returned row; losers must skip aggregation, ledger writes, and
 * notifications.
 *
 * A fresh 'finalizing' row is owned by the finalizer that set it, so a second
 * concurrent claim loses. A claim older than `FINALIZE_STALE_MS` is assumed to
 * belong to a crashed finalizer and may be reclaimed (finalizing -> finalizing);
 * every claim also restamps `finished_at`, which is what the comparison report
 * and the watcher's stale check read.
 */
export async function claimRunFinalization(runId: string, staleMs = FINALIZE_STALE_MS): Promise<boolean> {
  const db = getDrizzleDb();
  const now = Date.now();
  const staleBefore = new Date(now - staleMs).toISOString();
  const claimed = await db.update(runs)
    .set({ status: 'finalizing', finished_at: new Date(now).toISOString() })
    .where(and(
      eq(runs.run_id, runId),
      ne(runs.status, 'completed'),
      or(
        ne(runs.status, 'finalizing'),
        isNull(runs.finished_at),
        lt(runs.finished_at, staleBefore),
      ),
    ))
    .returning({ run_id: runs.run_id });
  return claimed.length > 0;
}

/**
 * Flip a claimed run finalizing -> completed after every finalization side
 * effect landed. Conditional on the run still being 'finalizing': a restart
 * that reset the run mid-finalize is not clobbered, and `finished_at` keeps the
 * claim-time value.
 */
export async function completeRunFinalization(runId: string): Promise<boolean> {
  const db = getDrizzleDb();
  const completed = await db.update(runs)
    .set({ status: 'completed' })
    .where(and(eq(runs.run_id, runId), eq(runs.status, 'finalizing')))
    .returning({ run_id: runs.run_id });
  return completed.length > 0;
}

/** Patch the run index with final status + comparison paths after finalize. */
export async function patchIndexAfterFinalize(runId: string, mdPath: string, jsonPath: string, perModel: RunIndexModelEntry[]): Promise<void> {
  await updateRun(runId, (rec) => {
    // Status stays 'finalizing' until completeRunFinalization; a crash here must
    // leave the run reclaimable by the watcher.
    // The claim already stamped finished_at once; never move it on a later write.
    rec.finishedAt = rec.finishedAt ?? new Date().toISOString();
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
        // Only the caller holding claimRunFinalization reaches this insert, so
        // it cannot be raced by a second finalizer. A row-existence guard is
        // deliberately not used: a restarted run legitimately accrues a new
        // ledger row for its new attempt.
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
