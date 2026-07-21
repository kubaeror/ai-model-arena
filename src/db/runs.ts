import path from 'node:path';
import { findProjectRoot } from '../paths.js';
import { getDb } from './index.js';

export interface RunIndexModelEntry {
  model: string;
  runId: string;
  procName: string;
  outputDir: string;
  sandboxDir: string;
  resultPath: string;
  conversationPath: string;
  reportPath: string;
  logFile: string;
  status: 'running' | 'completed' | 'errored' | 'stopped' | 'unknown';
  success?: boolean;
  turnsUsed?: number;
  totalToolCalls?: number;
  stopReason?: string;
  durationMs?: number;
}

export interface RunIndexRecord {
  runId: string;
  scenario: string;
  models: string[];
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'stopped' | 'errored' | 'unknown';
  source: 'cli' | 'dashboard' | 'scheduler';
  perModel: RunIndexModelEntry[];
  comparisonMdPath: string | null;
  comparisonJsonPath: string | null;
  createdBy?: string;
}

export interface RunIndexFile {
  runs: RunIndexRecord[];
}

function pmToDb(entry: RunIndexModelEntry): Record<string, unknown> {
  return {
    run_id: entry.runId,
    model: entry.model,
    proc_name: entry.procName,
    output_dir: entry.outputDir,
    sandbox_dir: entry.sandboxDir,
    result_path: entry.resultPath,
    conversation_path: entry.conversationPath,
    report_path: entry.reportPath,
    log_file: entry.logFile,
    status: entry.status,
    success: entry.success != null ? (entry.success ? 1 : 0) : null,
    turns_used: entry.turnsUsed ?? null,
    total_tool_calls: entry.totalToolCalls ?? null,
    stop_reason: entry.stopReason ?? null,
    duration_ms: entry.durationMs ?? null,
  };
}

function dbToPm(row: Record<string, unknown>): RunIndexModelEntry {
  return {
    runId: String(row.run_id ?? ''),
    model: String(row.model ?? ''),
    procName: row.proc_name ? String(row.proc_name) : '',
    outputDir: row.output_dir ? String(row.output_dir) : '',
    sandboxDir: row.sandbox_dir ? String(row.sandbox_dir) : '',
    resultPath: row.result_path ? String(row.result_path) : '',
    conversationPath: row.conversation_path ? String(row.conversation_path) : '',
    reportPath: row.report_path ? String(row.report_path) : '',
    logFile: row.log_file ? String(row.log_file) : '',
    status: String(row.status ?? 'unknown') as RunIndexModelEntry['status'],
    success: row.success != null ? Boolean(row.success) : undefined,
    turnsUsed: row.turns_used != null ? Number(row.turns_used) : undefined,
    totalToolCalls: row.total_tool_calls != null ? Number(row.total_tool_calls) : undefined,
    stopReason: row.stop_reason ? String(row.stop_reason) : undefined,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : undefined,
  };
}

export function indexPath(): string {
  return path.join(findProjectRoot(), 'outputs', 'runs-index.json');
}

export function loadRunIndex(): RunIndexFile {
  return { runs: listRuns() };
}

export function saveRunIndex(_idx: RunIndexFile): void {
  // No-op: writes go through upsertRun to the SQLite table.
}

export function listRuns(): RunIndexRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as Record<string, unknown>[];
  const allPm = db.prepare('SELECT * FROM run_models ORDER BY run_id').all() as Record<string, unknown>[];
  const pmByRun = new Map<string, Record<string, unknown>[]>();
  for (const pm of allPm) {
    const rid = String(pm.run_id);
    let list = pmByRun.get(rid);
    if (!list) { list = []; pmByRun.set(rid, list); }
    list.push(pm);
  }
  return rows.map((r) => {
    const models = JSON.parse(String(r.models)) as string[];
    return {
      runId: String(r.run_id),
      scenario: String(r.scenario),
      models,
      startedAt: String(r.started_at),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      status: String(r.status) as RunIndexRecord['status'],
      source: String(r.source) as RunIndexRecord['source'],
      perModel: (pmByRun.get(String(r.run_id)) ?? []).map(dbToPm),
      comparisonMdPath: r.comparison_md_path ? String(r.comparison_md_path) : null,
      comparisonJsonPath: r.comparison_json_path ? String(r.comparison_json_path) : null,
      createdBy: r.created_by ? String(r.created_by) : undefined,
    };
  });
}

export function getRunRecord(runId: string): RunIndexRecord | undefined {
  const db = getDb();
  const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const perModel = db.prepare('SELECT * FROM run_models WHERE run_id = ?').all(runId) as Record<string, unknown>[];
  const models = JSON.parse(String(r.models)) as string[];
  return {
    runId: String(r.run_id),
    scenario: String(r.scenario),
    models,
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    status: String(r.status) as RunIndexRecord['status'],
    source: String(r.source) as RunIndexRecord['source'],
    perModel: perModel.map(dbToPm),
    comparisonMdPath: r.comparison_md_path ? String(r.comparison_md_path) : null,
    comparisonJsonPath: r.comparison_json_path ? String(r.comparison_json_path) : null,
    createdBy: r.created_by ? String(r.created_by) : undefined,
  };
}

export function upsertRun(record: RunIndexRecord): Promise<void> {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO runs (run_id, scenario, models, started_at, finished_at, status, source, comparison_md_path, comparison_json_path, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.runId, record.scenario, JSON.stringify(record.models), record.startedAt,
      record.finishedAt, record.status, record.source, record.comparisonMdPath, record.comparisonJsonPath,
      record.createdBy ?? null,
    );
    if (record.perModel && record.perModel.length > 0) {
      const insertPm = db.prepare(`INSERT OR REPLACE INTO run_models
        (run_id, model, proc_name, output_dir, sandbox_dir, result_path, conversation_path, report_path, log_file, status, success, turns_used, total_tool_calls, stop_reason, duration_ms)
        VALUES (@run_id, @model, @proc_name, @output_dir, @sandbox_dir, @result_path, @conversation_path, @report_path, @log_file, @status, @success, @turns_used, @total_tool_calls, @stop_reason, @duration_ms)`);
      for (const pm of record.perModel) {
        insertPm.run(pmToDb(pm));
      }
    }
  });
  tx();
  return Promise.resolve();
}

export function updateRun(
  runId: string,
  mutator: (rec: RunIndexRecord) => void,
): Promise<RunIndexRecord | undefined> {
  const rec = getRunRecord(runId);
  if (!rec) return Promise.resolve(undefined);
  mutator(rec);
  return upsertRun(rec).then(() => rec);
}
