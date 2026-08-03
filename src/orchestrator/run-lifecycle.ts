import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load } from 'js-yaml';
import type { Logger } from '../types.js';
import { writeComparison, type ComparisonEntry } from '../logger/comparison-logger.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadBudgetConfig, checkBudget, addSpend, reserveBudget, releaseReservation, getPricing } from '../cost-tracking/index.js';
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
import { runJudgeScoring, loadEvaluationConfig } from '../evaluation/judge.js';

function makeIdempotencyKey(scenario: string, models: string[]): string {
  return crypto.createHash('sha256').update(`${scenario}:${models.join(',')}`).digest('hex').slice(0, 32);
}

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

  await registerRun(spec, opts.source ?? 'cli', opts.createdBy);
  logger.info('Run enqueued', { runId, models: spec.models.map(m => m.model), tasks: spec.models.length });
  return spec;
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

/** Read results, write comparison, update index. Used by the CLI (has a spec). */
export async function finalizeRun(spec: RunSpec, logger: Logger): Promise<{
  entries: ComparisonEntry[];
  mdPath: string;
  jsonPath: string;
}> {
  const { entries, mdPath, jsonPath } = aggregate(spec.root!, {
    runId: spec.runId, scenario: spec.scenario, startedAt: spec.startedAt,
    models: spec.models.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const perModel: RunIndexModelEntry[] = spec.models.map((m) => {
    const r = entries.find((x) => x.model === m.model)?.result;
    const base = {
      model: m.model, runId: spec.runId, procName: m.procName, outputDir: m.outputDir,
      sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
      reportPath: m.reportPath, logFile: m.logFile,
    };
    return r
      ? { ...base, status: 'completed', success: r.success, turnsUsed: r.turnsUsed, totalToolCalls: r.totalToolCalls, stopReason: r.stopReason, durationMs: r.durationMs }
      : { ...base, status: 'errored' };
  });
  await patchIndexAfterFinalize(spec.runId, mdPath, jsonPath, perModel);

  // Release budget reservations with actual costs
  for (const entry of entries) {
    const actualCost = entry.result?.costUsd ?? 0;
    const estimatedCost = actualCost > 0 ? actualCost * 2 : 1; // rough estimate
    releaseReservation(entry.model, estimatedCost, actualCost, spec.root!, logger);
  }

  logger.info('Comparison written', { md: mdPath, json: jsonPath });
  // Record spend for budget tracking
  for (const entry of entries) {
    if (entry.result && typeof entry.result.costUsd === 'number' && entry.result.costUsd > 0) {
      void addSpend(entry.model, entry.result.costUsd, spec.root!, logger);
      // Write to immutable cost ledger
      try {
        const { insertCostLedgerEntry, getLatestPricingVersion } = await import('../db/query.js');
        const tokens = entry.result.tokenUsage ?? {};
        const pricingVersion = await getLatestPricingVersion();
        await insertCostLedgerEntry({
          runId: spec.runId, model: entry.model, costUsd: entry.result.costUsd,
          inputTokens: tokens.prompt ?? null,
          outputTokens: tokens.completion ?? null,
          cacheReadTokens: tokens.cacheReadTokens ?? null,
          totalTokens: tokens.total ?? null,
          pricingVersion,
          recordedAt: new Date().toISOString(),
        });
      } catch (e) {
        logger.warn('cost ledger write failed (non-fatal)', { runId: spec.runId, model: entry.model, err: String(e) });
      }
    }
  }
  // Run anomaly detection over the just-completed run (best-effort, non-blocking).
  void analyzeRun(spec.runId, logger).catch((e) => {
    anomalyAnalysisFailures++;
    logger.warn('Anomaly analysis failed', { runId: spec.runId, error: e instanceof Error ? e.message : String(e), totalFailures: anomalyAnalysisFailures });
  });
  return { entries, mdPath, jsonPath };
}

/** Finalize by runId (resolves paths from the index). Used by the dashboard watcher. */
export async function finalizeRunByRunId(runId: string, logger: Logger): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) return;
  const root = pm2h.projectRoot();
  const { mdPath, jsonPath } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const perModel: RunIndexModelEntry[] = await Promise.all(rec.perModel.map(async (m) => {
    let r: { success?: boolean; turnsUsed?: number; totalToolCalls?: number; stopReason?: string; durationMs?: number; costUsd?: number } | undefined;
    try {
      r = JSON.parse(fs.readFileSync(m.resultPath, 'utf8'));
    } catch {
      r = undefined;
    }
    // Record spend for budget tracking
    if (r && typeof r.costUsd === 'number' && r.costUsd > 0) {
      void addSpend(m.model, r.costUsd, root, logger);
      // Write to immutable cost ledger
      try {
        const { insertCostLedgerEntry } = await import('../db/query.js');
        const tokens = (r as Record<string, unknown>).tokenUsage as Record<string, number> | undefined ?? {};
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
    return r
      ? { ...m, status: 'completed', success: r.success, turnsUsed: r.turnsUsed, totalToolCalls: r.totalToolCalls, stopReason: r.stopReason, durationMs: r.durationMs }
      : { ...m, status: 'errored' };
  }));
  await patchIndexAfterFinalize(runId, mdPath, jsonPath, perModel);
  logger.info('Finalized run via watcher', { runId, md: mdPath });
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
  // Run LLM judge scoring (best-effort, non-blocking).
  void (async () => {
    try {
      const evalCfg = loadEvaluationConfig(path.join(root, 'configs', 'evaluation.yaml'), logger);
      if (evalCfg.judge?.enabled) {
        for (const m of rec.perModel) {
          const resultPath = m.resultPath;
          if (!fs.existsSync(resultPath)) continue;
          const scenarioPath = path.join(root, 'configs', 'scenarios', `${rec.scenario}.yaml`);
          const scenarioCfg = fs.existsSync(scenarioPath) ? (load(fs.readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>) : null;
          const task = (scenarioCfg?.task as string) ?? '';
          const files: Record<string, string> = {};
          try {
            for (const f of fs.readdirSync(m.sandboxDir, { withFileTypes: true }).filter(e => e.isFile())) {
              files[f.name] = fs.readFileSync(path.join(m.sandboxDir, f.name), 'utf8').slice(0, 4000);
            }
          } catch { /* sandbox may not exist */ }
          await runJudgeScoring(m.model, runId, task, files, evalCfg, logger);
        }
      }
    } catch (e) {
      logger.warn('judge scoring failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e) });
    }
  })();
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
  await updateRun(runId, (r) => {
    r.status = 'running';
    r.finishedAt = null;
    for (const m of r.perModel) { m.status = 'running'; m.success = undefined; }
  });
}


