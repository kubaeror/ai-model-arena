import { createLogger } from '../logger/pino-logger.js';
import type { ComparisonEntry } from '../logger/comparison-logger.js';
import { sleep } from './utils.js';
import { listRuns, getRunRecord } from './run-index.js';
import {
  startRun,
  isRunComplete,
  finalizeRun,
  ensureBuilt,
  createRunSpec,
  spawnRunWorkers,
  registerRun,
  checkRunStatus,
  isRunCompleteByRunId,
  finalizeRunByRunId,
  stopRun,
  restartRun,
  type RunStartOptions,
  type RunSpec,
  type PerModelSpec,
  type PerModelStatus,
} from './run-lifecycle.js';

// ── Canonical re-export surface for the dashboard server ────────────────────
// The dashboard imports everything it needs from this one module rather than
// duplicating PM2 spawn logic.
export {
  ensureBuilt,
  createRunSpec,
  spawnRunWorkers,
  registerRun,
  startRun,
  checkRunStatus,
  isRunComplete,
  isRunCompleteByRunId,
  finalizeRun,
  finalizeRunByRunId,
  stopRun,
  restartRun,
  listRuns,
  getRunRecord,
  type RunStartOptions,
  type RunSpec,
  type PerModelSpec,
  type PerModelStatus,
};
export type { RunIndexRecord, RunIndexModelEntry } from './run-index.js';
export { ARENA_PREFIX, DASHBOARD_PROC_NAME } from './utils.js';

export interface CliRunOptions extends RunStartOptions {
  timeoutMs?: number;
}

/** CLI entry point: spawn workers, wait for completion, finalize, print table. */
export async function runScenarioForModels(opts: CliRunOptions): Promise<void> {
  const logger = opts.logger ?? createLogger('ai-arena:orchestrator');
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const spec = await startRun({ ...opts, source: 'cli' });
  logger.info('Starting arena run', {
    scenario: opts.scenario,
    models: opts.models,
    runId: spec.runId,
  });

  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (Date.now() < deadline) {
    if (await isRunComplete(spec)) {
      done = true;
      break;
    }
    await sleep(1500);
  }
  if (!done) logger.warn('Timeout reached while waiting for workers; proceeding with partial results.');

  const { entries } = await finalizeRun(spec, logger);
  printComparisonTable(entries);
  logger.info('Run complete.');
}

function printComparisonTable(entries: ComparisonEntry[]): void {
  const rows = entries.map((e) => {
    const r = e.result;
    return {
      model: e.model,
      success: r?.success ? 'PASS' : r ? 'FAIL' : 'CRASH',
      turns: r ? `${r.turnsUsed}/${r.maxTurns}` : '-',
      tools: r?.totalToolCalls ?? '-',
      duration: r ? `${(r.durationMs / 1000).toFixed(1)}s` : '-',
      stop: r?.stopReason ?? (e.error ? 'crashed' : '-'),
    };
  });
  const cols: (keyof (typeof rows)[number])[] = ['model', 'success', 'turns', 'tools', 'duration', 'stop'];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const header = cols.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = rows.map((r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i]!)).join(' | ')).join('\n');
  console.log('\n' + header + '\n' + sep + '\n' + body + '\n');
}

/** All runs from the index. */
export async function listArenaProcesses(): Promise<unknown[]> {
  return listRuns().map(r => ({
    name: r.runId,
    status: r.status,
    pid: null,
    monit: null,
    pm2_env: { status: r.status, unstable_restarts: 0, exit_code: null },
  }));
}

/** Print a status table of all runs (CLI `status` command). */
export async function printStatus(): Promise<void> {
  const runs = listRuns();
  if (runs.length === 0) {
    console.log('No ai-arena runs found.');
    console.log('Run one with: ai-arena run --scenario <name> --models <list>');
    return;
  }
  const rows = runs.map((r) => ({
    id: r.runId,
    status: r.status,
    scenario: r.scenario,
    models: r.models.join(','),
    startedAt: r.startedAt,
    source: r.source,
  }));
  const cols: (keyof (typeof rows)[number])[] = ['id', 'status', 'scenario', 'models', 'startedAt', 'source'];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((x) => String(x[c] ?? '').length)));
  const header = cols.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = rows.map((r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i]!)).join(' | ')).join('\n');
  console.log('\n' + header + '\n' + sep + '\n' + body + '\n');
}

/** Tail logs from pino output for a given model (CLI `logs` command). */
export async function tailLogs(_model: string, _lines = 200): Promise<void> {
  console.log('Logs are written to stdout during runner execution.');
  console.log('For structured logs, check the pino output or container logs (kubectl logs).');
}

/** Cancel in-flight tasks (CLI `cleanup` command). */
export async function cleanupArena(): Promise<void> {
  console.log('Cleanup: In-flight tasks will be automatically requeued or sent to DLQ on timeout.');
}

