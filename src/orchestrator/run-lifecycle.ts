import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StartOptions } from 'pm2';
import type { Logger } from '../types.js';
import { loadModelsConfig, findModel } from '../config.js';
import { writeComparison, type ComparisonEntry } from '../logger/comparison-logger.js';
import { createLogger } from '../logger/pino-logger.js';
import { loadBudgetConfig, loadPricingConfig, checkBudget } from '../cost-tracking/index.js';
import * as pm2h from './pm2-helpers.js';
import {
  upsertRun,
  updateRun,
  getRunRecord,
  type RunIndexModelEntry,
} from './run-index.js';
import { analyzeRun } from '../anomaly-detection/index.js';

export interface PerModelSpec {
  model: string;
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

/** Build the project (tsc) if the compiled worker is missing. */
export async function ensureBuilt(root: string, logger: Logger): Promise<void> {
  const worker = pm2h.workerScriptPath(root);
  if (fs.existsSync(worker)) return;
  logger.info('Compiled worker not found — building project (npm run build)...');
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    throw new Error(
      `Failed to build automatically. Run "npm run build" first. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

/** Validate models + compute all run paths (no PM2, no spawning). */
export function createRunSpec(opts: RunStartOptions): RunSpec {
  const root = pm2h.projectRoot();
  const modelsConfigPath = opts.modelsConfigPath ?? path.join(root, 'configs', 'models.yaml');
  const scenariosDir = opts.scenariosDir ?? path.join(root, 'configs', 'scenarios');
  const models = loadModelsConfig(modelsConfigPath);
  for (const name of opts.models) findModel(models.models, name);

  const ts = pm2h.timestamp();
  const runId = `${opts.scenario}_${ts}`;
  const perModel: PerModelSpec[] = opts.models.map((model) => {
    const procName = pm2h.sanitizeName(`${pm2h.ARENA_PREFIX}${model}-${opts.scenario}-${ts}`);
    const outputDir = path.join(root, 'outputs', model, runId);
    const pm2LogDir = path.join(root, 'outputs', model, 'pm2-logs');
    fs.mkdirSync(pm2LogDir, { recursive: true });
    return {
      model,
      procName,
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
    modelsConfigPath,
    scenariosDir,
    comparisonBase: path.join(root, 'outputs', 'comparisons', runId),
    models: perModel,
  };
}

/** Connect to PM2 and start one worker per model, then disconnect. */
export async function spawnRunWorkers(spec: RunSpec, logger: Logger): Promise<void> {
  await pm2h.pm2Connect();
  try {
    for (const m of spec.models) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        AI_ARENA_MODEL: m.model,
        AI_ARENA_SCENARIO: spec.scenario,
        AI_ARENA_RUN_ID: spec.runId,
        AI_ARENA_ROOT: spec.root!,
        AI_ARENA_MODELS_CONFIG: spec.modelsConfigPath,
        AI_ARENA_SCENARIOS_DIR: spec.scenariosDir,
      };
      const startOpts: StartOptions = {
        name: m.procName,
        script: pm2h.workerScriptPath(spec.root!),
        interpreter: 'node',
        exec_mode: 'fork',
        autorestart: false,
        max_restarts: 0,
        cwd: spec.root!,
        time: true,
        merge_logs: true,
        out_file: m.logFile,
        error_file: m.logFile,
        env,
      };
      logger.info('Spawning worker', { procName: m.procName, model: m.model, runId: spec.runId });
      await pm2h.pm2Start(startOpts);
    }
  } finally {
    await pm2h.pm2Disconnect();
  }
}

/** Register a run (status=running) in the index. */
export async function registerRun(spec: RunSpec, source: 'cli' | 'dashboard' | 'scheduler' = 'cli'): Promise<void> {
  const perModel: RunIndexModelEntry[] = spec.models.map((m) => ({
    model: m.model, runId: spec.runId, procName: m.procName, outputDir: m.outputDir,
    sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
    reportPath: m.reportPath, logFile: m.logFile, status: 'running',
  }));
  await upsertRun({
    runId: spec.runId, scenario: spec.scenario, models: spec.models.map((m) => m.model),
    startedAt: spec.startedAt, finishedAt: null, status: 'running', source, perModel,
    comparisonMdPath: null, comparisonJsonPath: null,
  });
}

/** Non-blocking: validate, build, spawn workers, register in index, return spec. */
export async function startRun(opts: RunStartOptions): Promise<RunSpec> {
  const root = pm2h.projectRoot();
  const logger = opts.logger ?? createLogger('ai-arena:orchestrator');
  await ensureBuilt(root, logger);
  
  // Load budget and pricing configs for enforcement
  loadPricingConfig(path.join(root, 'configs', 'pricing.yaml'), logger);
  loadBudgetConfig(path.join(root, 'configs', 'budget.yaml'), logger);
  
  // Check budget for each model before starting
  for (const modelName of opts.models) {
    const budgetCheck = checkBudget(modelName, root, opts.forceBudget ?? false, logger);
    if (!budgetCheck.allowed) {
      throw new Error(budgetCheck.reason ?? `Budget exceeded for ${modelName}`);
    }
    if (budgetCheck.percentUsed >= 80) {
      logger.warn(`Budget threshold approach for ${modelName}`, { 
        spent: budgetCheck.spentUsd, 
        limit: budgetCheck.limitUsd, 
        percent: budgetCheck.percentUsed 
      });
    }
  }
  
  const spec = createRunSpec(opts);
  await spawnRunWorkers(spec, logger);
  await registerRun(spec, opts.source ?? 'cli');
  return spec;
}

/** Query live PM2 status for each model in a run. */
export async function checkRunStatus(spec: RunSpec): Promise<PerModelStatus[]> {
  await pm2h.pm2Connect();
  try {
    const list = await pm2h.pm2List();
    return spec.models.map((m) => {
      const p = list.find((x) => x.name === m.procName);
      return {
        model: m.model, procName: m.procName, status: p?.pm2_env?.status ?? 'absent',
        pid: p?.pid ?? null, cpu: p?.monit?.cpu, memory: p?.monit?.memory,
        uptime: p?.pm2_env?.pm_uptime, restarts: p?.pm2_env?.unstable_restarts,
        exitCode: p?.pm2_env?.exit_code ?? null, online: p ? pm2h.isOnline(p) : false,
      };
    });
  } finally {
    await pm2h.pm2Disconnect();
  }
}

export async function isRunComplete(spec: RunSpec): Promise<boolean> {
  return (await checkRunStatus(spec)).every((s) => !s.online);
}

/** True iff every model's worker process in a run (looked up by runId) is stopped. */
export async function isRunCompleteByRunId(runId: string): Promise<boolean> {
  const rec = getRunRecord(runId);
  if (!rec || rec.perModel.length === 0) return true;
  await pm2h.pm2Connect();
  try {
    const list = await pm2h.pm2List();
    return rec.perModel.every((m) => {
      const p = list.find((x) => x.name === m.procName);
      return !p || !pm2h.isOnline(p);
    });
  } finally {
    await pm2h.pm2Disconnect();
  }
}

interface AggregateInput {
  runId: string;
  scenario: string;
  startedAt: string;
  models: { model: string; resultPath: string }[];
}
function aggregate(root: string, input: AggregateInput): {
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
    path.join(root, 'outputs', 'comparisons', input.runId),
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
  logger.info('Comparison written', { md: mdPath, json: jsonPath });
  // Run anomaly detection over the just-completed run (best-effort, non-blocking).
  void analyzeRun(spec.runId, logger).catch((e) =>
    logger.warn('Anomaly analysis failed', { runId: spec.runId, error: e instanceof Error ? e.message : String(e) }),
  );
  return { entries, mdPath, jsonPath };
}

/** Finalize by runId (resolves paths from the index). Used by the dashboard watcher. */
export async function finalizeRunByRunId(runId: string, logger: Logger): Promise<void> {
  const rec = getRunRecord(runId);
  if (!rec) return;
  const root = pm2h.projectRoot();
  const { mdPath, jsonPath } = aggregate(root, {
    runId, scenario: rec.scenario, startedAt: rec.startedAt,
    models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })),
  });
  const perModel: RunIndexModelEntry[] = rec.perModel.map((m) => {
    let r: { success?: boolean; turnsUsed?: number; totalToolCalls?: number; stopReason?: string; durationMs?: number } | undefined;
    try {
      r = JSON.parse(fs.readFileSync(m.resultPath, 'utf8'));
    } catch {
      r = undefined;
    }
    return r
      ? { ...m, status: 'completed', success: r.success, turnsUsed: r.turnsUsed, totalToolCalls: r.totalToolCalls, stopReason: r.stopReason, durationMs: r.durationMs }
      : { ...m, status: 'errored' };
  });
  await patchIndexAfterFinalize(runId, mdPath, jsonPath, perModel);
  logger.info('Finalized run via watcher', { runId, md: mdPath });
  // Run anomaly detection over the just-completed run (best-effort, non-blocking).
  void analyzeRun(runId, logger).catch((e) =>
    logger.warn('Anomaly analysis failed', { runId, error: e instanceof Error ? e.message : String(e) }),
  );
}

/** Stop a running run's PM2 processes (keeps them in the PM2 list). */
export async function stopRun(runId: string): Promise<void> {
  const rec = getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  await pm2h.pm2Connect();
  try {
    for (const m of rec.perModel) await pm2h.pm2Stop(m.procName).catch(() => undefined);
  } finally {
    await pm2h.pm2Disconnect();
  }
  await updateRun(runId, (r) => { r.status = 'stopped'; });
}

/** Restart a run's PM2 processes (re-runs the workers with the same runId). */
export async function restartRun(runId: string): Promise<void> {
  const rec = getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  await pm2h.pm2Connect();
  try {
    for (const m of rec.perModel) await pm2h.pm2Restart(m.procName).catch(() => undefined);
  } finally {
    await pm2h.pm2Disconnect();
  }
  await updateRun(runId, (r) => {
    r.status = 'running';
    r.finishedAt = null;
    for (const m of r.perModel) { m.status = 'running'; m.success = undefined; }
  });
}


