import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../types.js';
import type { ComparisonEntry } from '../logger/comparison-logger.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadBudgetConfig, checkBudget, reserveBudget, releaseReservation, getPricing, budgetStateRoot } from '../cost-tracking/index.js';
import { projectRoot, timestamp } from './utils.js';
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
import type { ModelAdapter } from '../providers/adapters/base.js';
import {
  aggregate,
  patchIndexAfterFinalize,
  buildPerModelEntries,
} from './finalize/aggregate.js';
import { recordRunReservations, releaseRunReservations } from './finalize/budget.js';
import { runJudgeScoringPass } from './finalize/judge.js';
import { runAnomalyAnalysis, writebackRuntimeStats } from './finalize/anomalies.js';
import { notifyRunCompleted } from './finalize/notify.js';

function makeIdempotencyKey(scenario: string, models: string[]): string {
  return crypto.createHash('sha256').update(`${scenario}:${models.join(',')}`).digest('hex').slice(0, 32);
}

/** Non-blocking: fire budget_exceeded webhooks for a model that tripped its budget limit. */
export async function dispatchBudgetExceeded(
  modelName: string,
  check: { spentUsd: number; limitUsd: number | null; percentUsed: number; reason?: string },
  logger?: Logger,
): Promise<void> {
  try {
    const { dispatchWebhooks } = await import('../notifications/webhooks.js');
    await dispatchWebhooks('budget_exceeded', {
      model: modelName,
      spentUsd: check.spentUsd,
      limitUsd: check.limitUsd,
      percentUsed: check.percentUsed,
      reason: check.reason ?? `Budget exceeded for ${modelName}`,
    }, logger);
  } catch { /* non-blocking */ }
}

/**
 * Tokens per turn used for the up-front cost estimate. Configurable via
 * RUN_COST_ESTIMATE_TOKENS (integer, fallback 8000, clamped to >= 1).
 */
function costEstimateTokensPerTurn(): number {
  const raw = Number.parseInt(process.env.RUN_COST_ESTIMATE_TOKENS ?? '', 10);
  if (Number.isNaN(raw)) return 8000;
  return Math.max(1, raw);
}

export interface PerModelSpec {
  model: string;
  providerId: string;
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
  status: string;
  exitCode: number | null;
  online: boolean;
}

/** Validate models + compute all run paths (no PM2, no spawning). */
export async function createRunSpec(opts: RunStartOptions): Promise<RunSpec> {
  const root = projectRoot();
  const scenariosDir = opts.scenariosDir ?? path.join(root, 'configs', 'scenarios');
  initDb(dbPath());
  for (const name of opts.models) {
    const resolved = await resolveModelForRun(name);
    if (!resolved) {
      throw new Error(`Model not found in catalog: ${name}. Run catalog sync first.`);
    }
  }

  const ts = timestamp();
  const runId = `${opts.scenario}_${ts}`;
  const perModel: PerModelSpec[] = await Promise.all(opts.models.map(async (model) => {
    const resolved = await resolveModelForRun(model);
    const outputDir = path.join(outputRoot(), model, runId);
    const pm2LogDir = path.join(outputRoot(), model, 'pm2-logs');
    fs.mkdirSync(pm2LogDir, { recursive: true });
    return {
      model,
      providerId: resolved?.providerId ?? 'unknown',
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
    model: m.model, runId: spec.runId, outputDir: m.outputDir,
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
  const root = projectRoot();
  // Budget STATE (cumulative spend + reservations) follows the output root
  // when OUTPUT_ROOT is set, so test/dev runs never pollute the repo's
  // shared state file; otherwise it stays under projectRoot (AI_ARENA_ROOT
  // honored) exactly as before.
  const budgetRoot = budgetStateRoot(root);
  const logger = opts.logger ?? createLogger('ai-arena:orchestrator');
  
  // Load budget config for enforcement (pricing now comes from the SQLite catalog)
  loadBudgetConfig(path.join(root, 'configs', 'budget.yaml'), logger);
  
  // Check budget for each model before starting
  const reservations: Array<{ model: string; estimated: number }> = [];
  try {
    for (const modelName of opts.models) {
    const budgetCheck = checkBudget(modelName, budgetRoot, opts.forceBudget ?? false, logger);
    if (!budgetCheck.allowed) {
      const reason = budgetCheck.reason ?? `Budget exceeded for ${modelName}`;
      // Dispatch budget_exceeded webhook first (non-blocking), then throw.
      void dispatchBudgetExceeded(modelName, budgetCheck, logger);
      throw new Error(reason);
    }

    // Estimate cost: assume maxTurns tokens × worst-case pricing
    const resolved = await resolveModelForRun(modelName);
    const maxTurns = resolved?.maxTurns ?? 20;
    const estTokensPerTurn = costEstimateTokensPerTurn();
    const pricingData = await getPricing(modelName);
    const inputPrice = pricingData?.input ?? 0;
    const outputPrice = pricingData?.output ?? 0;
    const estimatedCost = maxTurns * estTokensPerTurn * (inputPrice + outputPrice) / 1_000_000;

    const reservation = reserveBudget(modelName, estimatedCost, budgetRoot, logger);
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
  recordRunReservations(runId, reservations);

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
      releaseReservation(r.model, r.estimated, 0, budgetRoot, logger);
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
      model: m.model,
      status: pm?.status ?? (rec ? 'completed' : 'absent'),
      exitCode: null, online: pm?.status === 'running',
    };
  });
}

/** Statuses that mean a model's task reached an end state (never restarts on its own). */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'dead', 'errored']);

export function isRunComplete(spec: RunSpec): Promise<boolean> {
  const statuses = checkRunStatus(spec);
  return statuses.then((ss) => ss.every((s: PerModelStatus) =>
    !s.online && TERMINAL_STATUSES.has(s.status),
  ));
}

/** True iff every model in a run reached a terminal status (from the runs table). */
export async function isRunCompleteByRunId(runId: string): Promise<boolean> {
  const rec = await getRunRecord(runId);
  if (!rec || rec.perModel.length === 0) return false;
  return rec.perModel.every((m) => TERMINAL_STATUSES.has(m.status));
}

/**
 * Single finalize core shared by the CLI (spec) and dashboard watcher (runId) paths.
 * Aggregates results, patches the index, releases budget, records spend/ledger,
 * runs anomaly analysis + stats writeback, persists judge scores, and dispatches
 * the run_completed notification + webhook. Never throws on ancillary failures.
 */
async function finalizeCore(runId: string, entries: ComparisonEntry[], logger: Logger, judgeAdapter?: ModelAdapter): Promise<{ mdPath: string; jsonPath: string }> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  // Idempotency guard: the CLI and the dashboard watcher can both finalize a
  // run (watcher polls every 3s). A second pass would duplicate cost_ledger
  // and tool_call_stats rows and re-fire notifications.
  if (rec.status === 'completed') {
    logger.info('Run already finalized — skipping', { runId });
    return { mdPath: rec.comparisonMdPath ?? '', jsonPath: rec.comparisonJsonPath ?? '' };
  }
  const root = projectRoot();
  // Release budget reservations against the same state root they were
  // reserved under in startRun, so estimates always match.
  const budgetRoot = budgetStateRoot(root);
  const { mdPath, jsonPath } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const perModel = await buildPerModelEntries(runId, rec, entries, logger);
  await patchIndexAfterFinalize(runId, mdPath, jsonPath, perModel);
  const allSuccess = perModel.every((m) => m.status === 'completed' && m.success !== false);
  logger.info('Run finalized', { runId, md: mdPath, status: allSuccess ? 'success' : 'failed' });

  // Release budget reservations with actual costs, then best-effort
  // post-finalize jobs: anomaly analysis, stats writeback, judge scoring,
  // and completion notifications. All non-blocking, never fatal.
  releaseRunReservations(runId, entries, budgetRoot, logger);
  void runAnomalyAnalysis(runId, logger);
  void writebackRuntimeStats(runId, root, logger);
  void runJudgeScoringPass(root, runId, rec, logger, judgeAdapter);
  void notifyRunCompleted(root, runId, rec, allSuccess, logger);

  return { mdPath, jsonPath };
}

/** Read results, write comparison, update index. Used by the CLI (has a spec). */
export async function finalizeRun(spec: RunSpec, logger: Logger, judgeAdapter?: ModelAdapter): Promise<{
  entries: ComparisonEntry[];
  mdPath: string;
  jsonPath: string;
}> {
  const { entries } = aggregate(spec.root!, {
    runId: spec.runId, scenario: spec.scenario, startedAt: spec.startedAt,
    models: spec.models.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const core = await finalizeCore(spec.runId, entries, logger, judgeAdapter);
  return { entries, mdPath: core.mdPath, jsonPath: core.jsonPath };
}

/** Finalize by runId (resolves paths from the index). Used by the dashboard watcher. */
export async function finalizeRunByRunId(runId: string, logger: Logger, judgeAdapter?: ModelAdapter): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) return;
  const root = projectRoot();
  const { entries } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  await finalizeCore(runId, entries, logger, judgeAdapter);
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
  const ts = timestamp();
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
