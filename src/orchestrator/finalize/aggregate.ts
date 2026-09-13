import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
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
 * Statuses a finalization claim may start from: an initial 'running' run, a
 * user-stopped run awaiting aggregation, or a stale 'finalizing' claim being
 * reclaimed. Every other terminal status ('completed', 'errored', 'failed',
 * 'dead') is already settled and must never be re-finalized — a re-claim would
 * rewrite a failed outcome to 'completed' and duplicate side effects.
 */
const FINALIZABLE_STATUSES = ['running', 'stopped', 'finalizing'] as const;

/**
 * Atomically claim finalization of `runId`: one conditional UPDATE flips a
 * finalizable run to 'finalizing' and stamps `finished_at`. Exactly one
 * concurrent finalizer (runner self-finalize vs dashboard watcher vs CLI)
 * observes a returned row; losers must skip aggregation, ledger writes, and
 * notifications.
 *
 * A fresh 'finalizing' row is owned by the finalizer that set it, so a second
 * concurrent claim loses. A claim older than `FINALIZE_STALE_MS` is assumed to
 * belong to a crashed finalizer and may be reclaimed (finalizing -> finalizing);
 * every claim also restamps `finished_at`, which is what the comparison report
 * and the watcher's stale check read.
 *
 * Returns the finalization attempt number the caller must attribute its ledger
 * writes to, or null when the claim was lost. A stale reclaim of an already
 * finalizing run continues the crashed finalizer's attempt, so a retry writes
 * the same ledger key and cannot duplicate rows; a claim from any other
 * finalizable status opens a new attempt (restartRun resets the run to
 * 'running'), which legitimately records its own ledger row.
 */
export async function claimRunFinalization(runId: string, staleMs = FINALIZE_STALE_MS): Promise<number | null> {
  const db = getDrizzleDb();
  const now = Date.now();
  const staleBefore = new Date(now - staleMs).toISOString();
  const claimed = await db.update(runs)
    .set({
      status: 'finalizing',
      finished_at: new Date(now).toISOString(),
      finalization_attempt: sql<number>`case when ${runs.status} = 'finalizing' then ${runs.finalization_attempt} else ${runs.finalization_attempt} + 1 end`,
    })
    .where(and(
      eq(runs.run_id, runId),
      inArray(runs.status, [...FINALIZABLE_STATUSES]),
      or(
        ne(runs.status, 'finalizing'),
        isNull(runs.finished_at),
        // lte, not lt: staleMs=0 must admit a claim stamped in the same
        // millisecond (the documented "immediately reclaimable" contract).
        lte(runs.finished_at, staleBefore),
      ),
    ))
    .returning({ attempt: runs.finalization_attempt });
  return claimed.length > 0 ? claimed[0].attempt : null;
}

/**
 * Flip a claimed run finalizing -> completed after every finalization side
 * effect landed. Conditional on the run still being 'finalizing': a restart
 * that reset the run mid-finalize is not clobbered, and `finished_at` keeps the
 * claim-time value. A reaped run with no successful model settles as 'errored'
 * instead: its lifecycle is over but reporting 'completed' would read as
 * success for a run whose runner died.
 */
export async function completeRunFinalization(
  runId: string,
  status: 'completed' | 'errored' = 'completed',
): Promise<boolean> {
  const db = getDrizzleDb();
  const completed = await db.update(runs)
    .set({ status })
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
  finalizationAttempt: number,
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
        // Only the caller holding claimRunFinalization reaches this insert. A
        // retry of the same finalization attempt carries the same attempt
        // number, so the unique (run_id, model, finalization_attempt) key makes
        // the re-write a silent no-op; a genuinely new attempt (restartRun)
        // records its own ledger row.
        const tokens = r.tokenUsage ?? {};
        await insertCostLedgerEntry({
          runId, model: m.model, costUsd: r.costUsd,
          inputTokens: tokens.prompt ?? null,
          outputTokens: tokens.completion ?? null,
          cacheReadTokens: tokens.cacheReadTokens ?? null,
          totalTokens: tokens.total ?? null,
          pricingVersion: null,
          recordedAt: new Date().toISOString(),
          finalizationAttempt,
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
