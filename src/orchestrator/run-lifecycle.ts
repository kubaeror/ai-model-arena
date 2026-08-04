import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load } from 'js-yaml';
import type { Logger } from '../types.js';
import { writeComparison, type ComparisonEntry } from '../logger/comparison-logger.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadBudgetConfig, checkBudget, reserveBudget, releaseReservation, getPricing } from '../cost-tracking/index.js';
import * as pm2h from './pm2-helpers.js';
import { writeRunStats } from '../metrics/writeback.js';
import { resolveModelForRun } from '../db/model-resolver.js';
import { initDb } from '../db/index.js';
import { outputRoot, dbPath } from '../paths.js';
import { createQueue } from '../queue/index.js';
import type { Task } from '../queue/types.js';
import {
  upsertRun,
  updateRun,
  getRunRecord,
  type RunIndexModelEntry,
} from './run-index.js';
import { analyzeRun } from '../anomaly-detection/index.js';
import { runJudgeScoring, loadEvaluationConfig, writeJudgeResult } from '../evaluation/judge.js';

function makeIdempotencyKey(scenario: string, models: string[]): string {
  return crypto.createHash('sha256').update(`${scenario}:${models.join(',')}`).digest('hex').slice(0, 32);
}

/** Per-run budget reservations (runId -> model -> reserved USD). */
const runReservations = new Map<string, Map<string, number>>();

let anomalyAnalysisFailures = 0;
let statsWritebackFailures = 0;

/** Returns counts of post-run background task failures (non-fatal). */
export function getPostRunFailureCounts(): { anomalyAnalysis: number; statsWriteback: number } {
  return { anomalyAnalysis: anomalyAnalysisFailures, statsWriteback: statsWritebackFailures };
}

export interface PerModelSpec {
  model: string;
  providerId: string;
  procName: string;
  outputDir: string;
  sandboxDir: string;
  resultPath: string;
  conversationPath: string;
  reportPath: string;
  logFile: string;
}

export interface RunSpec {
  runId: string;
  scenario: string;
  ts: string;
  startedAt: string;
  root?: string;
  modelsConfigPath?: string;
  scenariosDir?: string;
  comparisonBase?: string;
  models: PerModelSpec[];
}

export interface RunStartOptions {
  scenario: string;
  models: string[];
  modelsConfigPath?: string;
  scenariosDir?: string;
  logger?: Logger;
  source?: 'cli' | 'dashboard' | 'scheduler';
  forceBudget?: boolean;
  timeoutMs?: number;
  createdBy?: string;
  promptId?: string;
  promptVersion?: number;
}

export interface PerModelStatus {
  model: string;
  procName: string;
  status: string;
  pid: number | null;
  cpu?: number;
  memory?: number;
  uptime?: number;
  restarts?: number;
  exitCode: number | null;
  online: boolean;
}

/** Validate models + compute all run paths (no PM2, no spawning). */
export async function createRunSpec(opts: RunStartOptions): Promise<RunSpec> {
  const root = pm2h.projectRoot();
  const scenariosDir = opts.scenariosDir ?? path.join(root, 'configs', 'scenarios');
  initDb(dbPath());
  for (const name of opts.models) {
    const resolved = await resolveModelForRun(name);
    if (!resolved) {
      throw new Error(`Model not found in catalog: ${name}. Run catalog sync first.`);
    }
  }

  const ts = pm2h.timestamp();
  const runId = `${opts.scenario}_${ts}`;
  const perModel: PerModelSpec[] = await Promise.all(opts.models.map(async (model) => {
    const resolved = await resolveModelForRun(model);
    const procName = pm2h.sanitizeName(`${pm2h.ARENA_PREFIX}${model}-${opts.scenario}-${ts}`);
    const outputDir = path.join(outputRoot(), model, runId);
    const pm2LogDir = path.join(outputRoot(), model, 'pm2-logs');
    fs.mkdirSync(pm2LogDir, { recursive: true });
    return {
      model,
      providerId: resolved?.providerId ?? 'unknown',
      procName,
      outputDir,
      sandboxDir: path.join(outputDir, 'files'),
      resultPath: path.join(outputDir, 'result.json'),
      conversationPath: path.join(outputDir, 'conversation.json'),
      reportPath: path.join(outputDir, 'report.md'),
      logFile: path.join(pm2LogDir, `${runId}.log`),
    };
  }));
  return {
    runId,
    scenario: opts.scenario,
    ts,
    startedAt: new Date().toISOString(),
    root,
    modelsConfigPath: opts.modelsConfigPath,
    scenariosDir,
    comparisonBase: path.join(outputRoot(), 'comparisons', runId),
    models: perModel,
  };
}

/** Register a run (status=running) in the index. */
export async function registerRun(spec: RunSpec, source: 'cli' | 'dashboard' | 'scheduler' = 'cli', createdBy?: string): Promise<void> {
  const perModel: RunIndexModelEntry[] = spec.models.map((m) => ({
    model: m.model, runId: spec.runId, procName: m.procName, outputDir: m.outputDir,
    sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
    reportPath: m.reportPath, logFile: m.logFile, status: 'running',
  }));
  await upsertRun({
    runId: spec.runId, scenario: spec.scenario, models: spec.models.map((m) => m.model),
    startedAt: spec.startedAt, finishedAt: null, status: 'running', source, perModel,
    comparisonMdPath: null, comparisonJsonPath: null, createdBy,
  });
}

/** Non-blocking: validate, build, spawn workers, register in index, return spec. */
export async function startRun(opts: RunStartOptions): Promise<RunSpec> {
  const root = pm2h.projectRoot();
  const logger = opts.logger ?? createLogger('ai-arena:orchestrator');
  
  // Load budget config for enforcement (pricing now comes from the SQLite catalog)
  loadBudgetConfig(path.join(root, 'configs', 'budget.yaml'), logger);
  
  // Check budget for each model before starting
  const reservations: Array<{ model: string; estimated: number }> = [];
  try {
    for (const modelName of opts.models) {
    const budgetCheck = checkBudget(modelName, root, opts.forceBudget ?? false, logger);
    if (!budgetCheck.allowed) {
      const reason = budgetCheck.reason ?? `Budget exceeded for ${modelName}`;
      // Dispatch budget_exceeded webhook first (non-blocking), then throw.
      void (async () => {
        try {
          const { dispatchWebhooks } = await import('../notifications/webhooks.js');
          await dispatchWebhooks('budget_exceeded', {
            model: modelName,
            spentUsd: budgetCheck.spentUsd,
            limitUsd: budgetCheck.limitUsd,
            percentUsed: budgetCheck.percentUsed,
            reason,
          }, logger);
        } catch { /* non-blocking */ }
      })();
      throw new Error(reason);
    }

    // Estimate cost: assume maxTurns tokens × worst-case pricing
    const resolved = await resolveModelForRun(modelName);
    const maxTurns = resolved?.maxTurns ?? 20;
    const estTokensPerTurn = 8000; // conservative estimate
    const pricingData = await getPricing(modelName);
    const inputPrice = pricingData?.input ?? 0;
    const outputPrice = pricingData?.output ?? 0;
    const estimatedCost = maxTurns * estTokensPerTurn * (inputPrice + outputPrice) / 1_000_000;

    const reservation = reserveBudget(modelName, estimatedCost, root, logger);
    if (!reservation.ok) {
      throw new Error(reservation.reason ?? `Budget reservation failed for ${modelName}`);
    }
    reservations.push({ model: modelName, estimated: estimatedCost });

    if (budgetCheck.percentUsed >= 80) {
      logger.warn(`Budget threshold approach for ${modelName}`, { 
        spent: budgetCheck.spentUsd, 
        limit: budgetCheck.limitUsd, 
        percent: budgetCheck.percentUsed 
      });
      // Dispatch threshold notification (non-blocking)
      void (async () => {
        try {
          const { loadNotificationConfig, dispatchNotification, DispatchEventType } = await import('../notifications/index.js');
          loadNotificationConfig(path.join(root, 'configs', 'notifications.yaml'), logger);
          await dispatchNotification({
            type: DispatchEventType.onBudgetThreshold,
            data: { model: modelName, spentUsd: budgetCheck.spentUsd, limitUsd: budgetCheck.limitUsd, percentUsed: budgetCheck.percentUsed },
            timestamp: new Date().toISOString(),
          }, logger);
        } catch { /* non-blocking */ }
      })();
    }
  }
  
  const spec = await createRunSpec(opts);
  const runId = spec.runId;
  runReservations.set(runId, new Map(reservations.map((r) => [r.model, r.estimated])));

  // Register before enqueue: a task that fails fast (e.g. missing API key)
  // writes its final state before the late registerRun upsert can clobber
  // it back to 'running' and wedge the run forever.
  await registerRun(spec, opts.source ?? 'cli', opts.createdBy);

  // Enqueue tasks for each model instead of spawning PM2 workers
  const queue = createQueue();
  const idemKey = makeIdempotencyKey(spec.scenario, spec.models.map(m => m.model));
  for (const m of spec.models) {
    const resolved = await resolveModelForRun(m.model);
    const task: Task = {
      taskId: `${runId}-${m.model}`,
      sessionId: `${runId}-${m.model}`,
      promptId: opts.promptId,
      promptVersion: opts.promptVersion ?? 1,
      provider: resolved?.providerId ?? 'unknown',
      model: m.model,
      scenario: spec.scenario,
      config: {
        modelRunId: runId,
        outputDir: m.outputDir,
        maxTurns: resolved?.maxTurns ?? 20,
      },
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      idempotencyKey: `${idemKey}-${m.model}`,
    };
    await queue.enqueue(task);
  }

  logger.info('Run enqueued', { runId, models: spec.models.map(m => m.model), tasks: spec.models.length });
  return spec;
  } catch (err) {
    // Never leak reservations: release everything reserved for this run,
    // whether a later model failed budget, createRunSpec, or enqueue did.
    for (const r of reservations) {
      releaseReservation(r.model, r.estimated, 0, root, logger);
    }
    throw err;
  }
}

/** Query live status for each model in a run from the runs table. */
export async function checkRunStatus(spec: RunSpec): Promise<PerModelStatus[]> {
  const rec = await getRunRecord(spec.runId);
  return spec.models.map((m) => {
    const pm = rec?.perModel.find((x) => x.model === m.model);
    return {
      model: m.model, procName: m.procName,
      status: pm?.status ?? (rec ? 'completed' : 'absent'),
      pid: null,
      cpu: undefined, memory: undefined,
      uptime: undefined, restarts: 0,
      exitCode: null, online: pm?.status === 'running',
    };
  });
}

export function isRunComplete(spec: RunSpec): Promise<boolean> {
  const statuses = checkRunStatus(spec);
  return statuses.then(ss => ss.every((s: PerModelStatus) => !s.online));
}

/** True iff every model in a run is stopped (from the runs table). */
export async function isRunCompleteByRunId(runId: string): Promise<boolean> {
  const rec = await getRunRecord(runId);
  if (!rec || rec.perModel.length === 0) return true;
  return rec.perModel.every((m) => m.status !== 'running');
}

interface AggregateInput {
  runId: string;
  scenario: string;
  startedAt: string;
  models: { model: string; resultPath: string }[];
}
function aggregate(_root: string, input: AggregateInput): {
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

async function patchIndexAfterFinalize(runId: string, mdPath: string, jsonPath: string, perModel: RunIndexModelEntry[]): Promise<void> {
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
async function buildPerModelEntries(
  runId: string,
  rec: Awaited<ReturnType<typeof getRunRecord>>,
  entries: ComparisonEntry[],
  logger: Logger,
): Promise<RunIndexModelEntry[]> {
  return Promise.all(rec!.perModel.map(async (m) => {
    const r = entries.find((x) => x.model === m.model)?.result;
    const base = {
      model: m.model, runId, procName: m.procName, outputDir: m.outputDir,
      sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
      reportPath: m.reportPath, logFile: m.logFile,
    };
    if (!r) return { ...base, status: 'errored' as const };
    if (typeof r.costUsd === 'number' && r.costUsd > 0) {
      try {
        const { insertCostLedgerEntry } = await import('../db/query.js');
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

/**
 * Single finalize core shared by the CLI (spec) and dashboard watcher (runId) paths.
 * Aggregates results, patches the index, releases budget, records spend/ledger,
 * runs anomaly analysis + stats writeback, persists judge scores, and dispatches
 * the run_completed notification + webhook. Never throws on ancillary failures.
 */
async function finalizeCore(runId: string, entries: ComparisonEntry[], logger: Logger): Promise<{ mdPath: string; jsonPath: string }> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  // Idempotency guard: the CLI and the dashboard watcher can both finalize a
  // run (watcher polls every 3s). A second pass would duplicate cost_ledger
  // and tool_call_stats rows and re-fire notifications.
  if (rec.status === 'completed') {
    logger.info('Run already finalized — skipping', { runId });
    return { mdPath: rec.comparisonMdPath ?? '', jsonPath: rec.comparisonJsonPath ?? '' };
  }
  const root = pm2h.projectRoot();
  const { mdPath, jsonPath } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const perModel = await buildPerModelEntries(runId, rec, entries, logger);
  await patchIndexAfterFinalize(runId, mdPath, jsonPath, perModel);
  const allSuccess = perModel.every((m) => m.status === 'completed' && m.success !== false);
  logger.info('Run finalized', { runId, md: mdPath, status: allSuccess ? 'success' : 'failed' });

  // Release budget reservations with actual costs (from FAT.min ledger costs).
  // Releasing the exact reserved amount keeps pendingReservations accurate —
  // a fabricated estimate leaked the remainder and eventually blocked all runs.
  const reservations = runReservations.get(runId) ?? new Map<string, number>();
  for (const entry of entries) {
    const actualCost = entry.result?.costUsd ?? 0;
    const reserved = reservations.get(entry.model) ?? 0;
    releaseReservation(entry.model, reserved, actualCost, root, logger);
  }
  runReservations.delete(runId);

  // Run anomaly detection over the just-completed run (best-effort, non-blocking).
  void analyzeRun(runId, logger).catch((e) => {
    anomalyAnalysisFailures++;
    logger.warn('Anomaly analysis failed', { runId, error: e instanceof Error ? e.message : String(e), totalFailures: anomalyAnalysisFailures });
  });
  // Write per-model runtime stats back to the SQLite catalog (best-effort, non-fatal).
  void writeRunStats(runId, root).catch((e) => {
    statsWritebackFailures++;
    logger.warn('writeRunStats failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e), totalFailures: statsWritebackFailures });
  });

  // LLM judge scoring + persist judge_score.json (feeds silent_failure detector + regression baselines).
  void (async () => {
    try {
      const evalCfg = loadEvaluationConfig(path.join(root, 'configs', 'evaluation.yaml'), logger);
      if (evalCfg.judge?.enabled) {
        for (const m of rec.perModel) {
          if (!fs.existsSync(m.resultPath)) continue;
          const scenarioPath = path.join(root, 'configs', 'scenarios', `${rec.scenario}.yaml`);
          const scenarioCfg = fs.existsSync(scenarioPath) ? (load(fs.readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>) : null;
          const task = (scenarioCfg?.task as string) ?? '';
          const files: Record<string, string> = {};
          try {
            for (const f of fs.readdirSync(m.sandboxDir, { withFileTypes: true }).filter(e => e.isFile())) {
              files[f.name] = fs.readFileSync(path.join(m.sandboxDir, f.name), 'utf8').slice(0, 4000);
            }
          } catch { /* sandbox may not exist */ }
          const verdict = await runJudgeScoring(m.model, runId, task, files, evalCfg, logger);
          if (verdict) writeJudgeResult(m.outputDir, verdict, logger);
        }
      }
    } catch (e) {
      logger.warn('judge scoring failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e) });
    }
  })();

  // Notifications + webhooks: single dispatch point for run completion.
  void (async () => {
    try {
      const { loadNotificationConfig, dispatchNotification, dispatchWebhooks, DispatchEventType } = await import('../notifications/index.js');
      loadNotificationConfig(path.join(root, 'configs', 'notifications.yaml'), logger);
      const data = { runId, scenario: rec.scenario, models: rec.perModel.map((m) => m.model), status: allSuccess ? 'success' : 'failed' };
      await dispatchNotification({ type: DispatchEventType.onRunCompleted, data, timestamp: new Date().toISOString() }, logger);
      await dispatchWebhooks('run_completed', data, logger);
    } catch { /* non-blocking */ }
  })();

  return { mdPath, jsonPath };
}

/** Read results, write comparison, update index. Used by the CLI (has a spec). */
export async function finalizeRun(spec: RunSpec, logger: Logger): Promise<{
  entries: ComparisonEntry[];
  mdPath: string;
  jsonPath: string;
}> {
  const { entries } = aggregate(spec.root!, {
    runId: spec.runId, scenario: spec.scenario, startedAt: spec.startedAt,
    models: spec.models.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const core = await finalizeCore(spec.runId, entries, logger);
  return { entries, mdPath: core.mdPath, jsonPath: core.jsonPath };
}

/** Finalize by runId (resolves paths from the index). Used by the dashboard watcher. */
export async function finalizeRunByRunId(runId: string, logger: Logger): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) return;
  const root = pm2h.projectRoot();
  const { entries } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  await finalizeCore(runId, entries, logger);
}

let killSwitchActive = false;

// Run-level cancellation signals — set when stopRun() is called, cleared on task completion
const cancelledRuns = new Set<string>();

/** Activate global kill switch — stops new runs, drains ongoing. */
export function activateKillSwitch(): void { killSwitchActive = true; }

/** Deactivate global kill switch. */
export function deactivateKillSwitch(): void { killSwitchActive = false; }

/** Check if kill switch is active. */
export function isKillSwitchActive(): boolean { return killSwitchActive; }

/** Check if a specific run has been cancelled. */
export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

/** Mark a run's cancellation as acknowledged (cleared by runner after stopping). */
export function clearRunCancelled(runId: string): void {
  cancelledRuns.delete(runId);
}

/** Stop a running run (marks as stopped in the index and signals cancellation). */
export async function stopRun(runId: string): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  cancelledRuns.add(runId);
  await updateRun(runId, (r) => { r.status = 'stopped'; });
}

/** Restart a run by re-enqueuing tasks. */
export async function restartRun(runId: string): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  cancelledRuns.delete(runId);
  const queue = createQueue();
  const ts = pm2h.timestamp();
  const idemKey = makeIdempotencyKey(rec.scenario, rec.perModel.map((m) => m.model));
  for (const m of rec.perModel) {
    const resolved = await resolveModelForRun(m.model);
    const task: Task = {
      taskId: `${runId}-${m.model}`,
      sessionId: `${runId}-${m.model}`,
      provider: resolved?.providerId ?? 'unknown',
      model: m.model,
      scenario: rec.scenario,
      config: {
        modelRunId: runId,
        outputDir: m.outputDir,
        maxTurns: resolved?.maxTurns ?? 20,
      },
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      // Unique idempotency key per restart: the dedup window (24h) would
      // otherwise swallow the re-enqueued task as a duplicate.
      idempotencyKey: `${idemKey}-${m.model}-restart-${ts}`,
    };
    await queue.enqueue(task);
  }
  await updateRun(runId, (r) => {
    r.status = 'running';
    r.finishedAt = null;
    for (const m of r.perModel) { m.status = 'running'; m.success = undefined; }
  });
}


