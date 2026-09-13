import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../types.js';
import type { ComparisonEntry } from '../logger/comparison-logger.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadBudgetConfig, checkBudget, reserveBudget, releaseReservation, computeCost, recordRunReservations, releaseRunReservations, budgetStateRoot } from '../cost-tracking/index.js';
import { projectRoot, timestamp } from './utils.js';
import { resolveModelForRun } from '../db/model-resolver.js';
import { initDb } from '../db/index.js';
import { outputRoot, dbPath, assertSafeId, modelDirSegment } from '../paths.js';
import { isWithin } from '../sandbox/sandbox.js';
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
  claimRunFinalization,
  patchIndexAfterFinalize,
  buildPerModelEntries,
} from './finalize/aggregate.js';
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

/**
 * Run ids are built from the scenario reference. CLI callers may pass an
 * explicit YAML path (whose dotted basename stem is sanitized, not rejected);
 * every other caller — including a caller that omitted `source` — must pass a
 * bare name, so a missing source can never unlock path scenarios.
 */
function scenarioIdFor(scenario: string, source: RunStartOptions['source']): string {
  const explicitPath = path.isAbsolute(scenario) || scenario.endsWith('.yaml') || scenario.endsWith('.yml');
  if (explicitPath) {
    if (source !== 'cli') {
      throw new Error(`Invalid identifier "${scenario}": scenario paths are only allowed for CLI-sourced runs`);
    }
    const stem = path.basename(scenario).replace(/\.(yaml|yml)$/i, '');
    return modelDirSegment(stem);
  }
  assertSafeId(scenario);
  return scenario;
}

/**
 * Model lookup keys are catalog keys (display names or canonical
 * `provider/id` ids), not paths, and the output directory segment is derived
 * from the resolved model — never from the key. This check only runs when a
 * key failed catalog resolution, so traversal-shaped input gets a clear
 * rejection instead of a generic catalog miss.
 */
function assertUnresolvedModelKeyIsNotPathLike(name: string): void {
  const pathLike = name.length === 0
    || name.includes('\0')
    || name.includes('/')
    || name.includes('\\')
    || name.includes('..')
    || path.isAbsolute(name)
    || name.startsWith('~');
  if (pathLike) {
    throw new Error(`Invalid identifier "${name}": model names must not contain path separators or ..`);
  }
}

/** Validate models + compute all run paths (no PM2, no spawning). */
export async function createRunSpec(opts: RunStartOptions): Promise<RunSpec> {
  const root = projectRoot();
  const scenariosDir = opts.scenariosDir ?? path.join(root, 'configs', 'scenarios');
  const scenarioId = scenarioIdFor(opts.scenario, opts.source);
  initDb(dbPath());
  // Resolve every lookup key before deriving any directory: resolvable keys may
  // legitimately contain spaces/dots or a `provider/id` slash, and only the
  // resolved canonical id feeds modelDirSegment.
  const resolvedModels = await Promise.all(opts.models.map(async (model) => {
    const resolved = await resolveModelForRun(model);
    if (!resolved) {
      assertUnresolvedModelKeyIsNotPathLike(model);
      throw new Error(`Model not found in catalog: ${model}. Run catalog sync first.`);
    }
    return { model, resolved };
  }));

  const ts = timestamp();
  const runId = `${scenarioId}_${ts}`;
  const perModel: PerModelSpec[] = resolvedModels.map(({ model, resolved }) => {
    const modelDir = modelDirSegment(resolved.canonicalId || model);
    const outputDir = path.join(outputRoot(), modelDir, runId);
    if (!isWithin(outputRoot(), path.resolve(outputDir))) {
      throw new Error(`Run output path escapes the output root: ${outputDir}`);
    }
    const pm2LogDir = path.join(outputRoot(), modelDir, 'pm2-logs');
    fs.mkdirSync(pm2LogDir, { recursive: true });
    return {
      model,
      providerId: resolved.providerId,
      outputDir,
      sandboxDir: path.join(outputDir, 'files'),
      resultPath: path.join(outputDir, 'result.json'),
      conversationPath: path.join(outputDir, 'conversation.json'),
      reportPath: path.join(outputDir, 'report.md'),
      logFile: path.join(pm2LogDir, `${runId}.log`),
    };
  });
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

/** Register a run (status=running) in the index. Never clobbers a terminal
 *  run or model: a fail-fast finalize may have written 'failed'/'stopped'
 *  before this upsert lands (e.g. crash between finalize and register). */
export async function registerRun(spec: RunSpec, source: 'cli' | 'dashboard' | 'scheduler' = 'cli', createdBy?: string): Promise<void> {
  const existing = await getRunRecord(spec.runId);
  if (existing && TERMINAL_STATUSES.has(existing.status)) return;
  const perModel: RunIndexModelEntry[] = spec.models
    .filter((m) => {
      const ex = existing?.perModel.find((p) => p.model === m.model);
      return !ex || !TERMINAL_STATUSES.has(ex.status);
    })
    .map((m) => ({
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

    // Estimate cost: assume maxTurns turns of the configured token budget,
    // priced through the single computeCost path (no second formula to drift).
    const resolved = await resolveModelForRun(modelName);
    const maxTurns = resolved?.maxTurns ?? 20;
    const estTokensPerTurn = costEstimateTokensPerTurn();
    const perTurnCost = await computeCost(modelName, {
      prompt: estTokensPerTurn,
      completion: estTokensPerTurn,
      cached: 0,
    });
    const estimatedCost = perTurnCost.total * maxTurns;

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
  recordRunReservations(runId, reservations, budgetRoot, logger);

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
        // No 'cli' fallback: an omitted source must never unlock path scenarios
        // in the runner (which gates path resolution on scenarioSource === 'cli').
        scenarioSource: opts.source,
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
 *
 * Callers must hold the atomic claim from `claimRunFinalization` before calling
 * this: it is the only guard that prevents a concurrent finalizer from
 * duplicating ledger rows, notifications, and stats.
 */
async function finalizeCore(runId: string, entries: ComparisonEntry[], mdPath: string, jsonPath: string, logger: Logger, judgeAdapter?: ModelAdapter): Promise<{ mdPath: string; jsonPath: string }> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  const root = projectRoot();
  // Release budget reservations against the same state root they were
  // reserved under in startRun, so estimates always match.
  const budgetRoot = budgetStateRoot(root);
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

/** Read results, write comparison, update index. Used by the CLI (has a spec).
 *  The atomic claim runs before aggregation so a losing finalizer does no work. */
export async function finalizeRun(spec: RunSpec, logger: Logger, judgeAdapter?: ModelAdapter): Promise<{
  entries: ComparisonEntry[];
  mdPath: string;
  jsonPath: string;
}> {
  if (!(await claimRunFinalization(spec.runId))) {
    const existing = await getRunRecord(spec.runId);
    if (!existing) throw new Error(`Run not found: ${spec.runId}`);
    logger.info('Run already finalized — skipping', { runId: spec.runId });
    return { entries: [], mdPath: existing.comparisonMdPath ?? '', jsonPath: existing.comparisonJsonPath ?? '' };
  }
  const { entries, mdPath, jsonPath } = aggregate(spec.root!, {
    runId: spec.runId, scenario: spec.scenario, startedAt: spec.startedAt,
    models: spec.models.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const core = await finalizeCore(spec.runId, entries, mdPath, jsonPath, logger, judgeAdapter);
  return { entries, mdPath: core.mdPath, jsonPath: core.jsonPath };
}

/** Finalize by runId (resolves paths from the index). Used by the dashboard
 *  watcher. Returns true when this call won the atomic claim (and finalized);
 *  false when the run is missing or another finalizer already claimed it. */
export async function finalizeRunByRunId(runId: string, logger: Logger, judgeAdapter?: ModelAdapter): Promise<boolean> {
  const rec = await getRunRecord(runId);
  if (!rec) return false;
  if (!(await claimRunFinalization(runId))) {
    logger.info('Run already finalized — skipping', { runId });
    return false;
  }
  const root = projectRoot();
  const { entries, mdPath, jsonPath } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  await finalizeCore(runId, entries, mdPath, jsonPath, logger, judgeAdapter);
  return true;
}

import {
  setKillSwitch as setKillSwitchSignal,
  isKillSwitchActive as isKillSwitchSignalActive,
  isRunCancelled as isRunCancelledSignal,
  markRunCancelled as markRunCancelledSignal,
  clearRunCancelled as clearRunCancelledSignal,
} from './run-signals.js';

/** Activate global kill switch — stops new runs, drains ongoing. */
export function activateKillSwitch(): Promise<void> { return setKillSwitchSignal(true); }

/** Deactivate global kill switch. */
export function deactivateKillSwitch(): Promise<void> { return setKillSwitchSignal(false); }

/** Check if kill switch is active. */
export function isKillSwitchActive(): Promise<boolean> { return isKillSwitchSignalActive(); }

/** Check if a specific run has been cancelled. */
export function isRunCancelled(runId: string): Promise<boolean> { return isRunCancelledSignal(runId); }

/** Mark a run's cancellation as acknowledged (cleared by runner after stopping). */
export function clearRunCancelled(runId: string): Promise<void> { return clearRunCancelledSignal(runId); }

/** Stop a running run (marks as stopped in the index and signals cancellation).
 *  A completed run is terminal: re-marking it stopped would let the dashboard
 *  watcher finalize it again (duplicate ledger rows/notifications). */
export async function stopRun(runId: string): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  if (rec.status === 'completed') return;
  await markRunCancelledSignal(runId);
  await updateRun(runId, (r) => {
    r.status = 'stopped';
    r.finishedAt = new Date().toISOString();
    for (const m of r.perModel) {
      if (m.status === 'running' || m.status === 'unknown') m.status = 'stopped';
    }
  });
}

/** Restart a run by re-enqueuing tasks. */
export async function restartRun(runId: string): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  await clearRunCancelledSignal(runId);
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
        scenarioSource: rec.source,
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
