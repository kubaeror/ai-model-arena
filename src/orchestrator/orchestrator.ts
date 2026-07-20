import fs from 'node:fs';
import path from 'node:path';
import type { Pm2ProcessStatus } from 'pm2';
import { createLogger } from '../logger/pino-logger.js';
import { outputRoot } from '../paths.js';
import type { ComparisonEntry } from '../logger/comparison-logger.js';
import * as pm2h from './pm2-helpers.js';
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
import { listRuns, getRunRecord } from './run-index.js';

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
export { ARENA_PREFIX, DASHBOARD_PROC_NAME } from './pm2-helpers.js';

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
    await pm2h.sleep(1500);
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

/** All currently-registered arena PM2 processes (running or stopped). */
export async function listArenaProcesses(): Promise<Pm2ProcessStatus[]> {
  const list = await pm2h.pm2ListOnce();
  return list.filter((p) => p.name?.startsWith(pm2h.ARENA_PREFIX));
}

/** Print a status table of all arena PM2 processes (CLI `status` command). */
export async function printStatus(): Promise<void> {
  const procs = await listArenaProcesses();
  if (procs.length === 0) {
    console.log('No ai-arena processes registered with PM2.');
    console.log('Run one with: ai-arena run --scenario <name> --models <list>');
    return;
  }
  const rows = procs.map((p) => ({
    name: p.name ?? '?',
    status: p.pm2_env?.status ?? '?',
    pid: p.pid != null ? String(p.pid) : '-',
    cpu: p.monit?.cpu != null ? `${p.monit.cpu}%` : '-',
    mem: p.monit?.memory != null ? pm2h.formatBytes(p.monit.memory) : '-',
    restarts: p.pm2_env?.unstable_restarts != null ? String(p.pm2_env.unstable_restarts) : '-',
    exitCode: p.pm2_env?.exit_code != null ? String(p.pm2_env.exit_code) : '-',
  }));
  const cols: (keyof (typeof rows)[number])[] = ['name', 'status', 'pid', 'cpu', 'mem', 'restarts', 'exitCode'];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const header = cols.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = rows.map((r) => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i]!)).join(' | ')).join('\n');
  console.log('\n' + header + '\n' + sep + '\n' + body + '\n');
}

/** Tail the most recent PM2 log file for a given model (CLI `logs` command). */
export async function tailLogs(model: string, lines = 200): Promise<void> {
  const dir = path.join(outputRoot(), model, 'pm2-logs');
  if (!fs.existsSync(dir)) {
    console.log(`No logs directory found for model "${model}".`);
    console.log(`Looked in: ${dir}`);
    console.log('Logs are written there once you run the model.');
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    console.log(`No log files found for model "${model}" in ${dir}`);
    return;
  }
  const latest = path.join(dir, files[0]!.f);
  const content = fs.readFileSync(latest, 'utf8');
  const tail = content.split(/\r?\n/).slice(-lines).join('\n');
  console.log(`--- ${latest} (last ${lines} lines) ---`);
  console.log(tail);
}

/** Delete all arena worker PM2 processes (CLI `cleanup` command); leaves the dashboard running. */
export async function cleanupArena(): Promise<void> {
  await pm2h.pm2Connect();
  try {
    const list = await pm2h.pm2List();
    const ours = list.filter(
      (p) => p.name?.startsWith(pm2h.ARENA_PREFIX) && p.name !== pm2h.DASHBOARD_PROC_NAME,
    );
    if (ours.length === 0) {
      console.log('No ai-arena processes to clean up.');
      return;
    }
    for (const p of ours) {
      if (p.name) await pm2h.pm2Delete(p.name).catch(() => undefined);
    }
    console.log(`Deleted ${ours.length} ai-arena process(es): ${ours.map((p) => p.name).join(', ')}`);
  } finally {
    await pm2h.pm2Disconnect();
  }
}

