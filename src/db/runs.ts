import { getDrizzleDb } from './index.js';
import { runs, run_models } from './schema.js';
import type { DbRun, DbRunModel } from './schema.js';
import { eq, desc, gte, inArray, or } from 'drizzle-orm';
import { chunkedIn } from './query/chunked.js';

export interface RunIndexModelEntry {
  model: string;
  runId: string;
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
  status: 'running' | 'finalizing' | 'completed' | 'stopped' | 'errored' | 'unknown';
  source: 'cli' | 'dashboard' | 'scheduler';
  perModel: RunIndexModelEntry[];
  comparisonMdPath: string | null;
  comparisonJsonPath: string | null;
  createdBy?: string;
  /** Set when the dashboard reaps a stale dead-runner run; cleared on restart. */
  reapedAt?: string | null;
}

export interface RunIndexFile {
  runs: RunIndexRecord[];
}

function pmToDb(entry: RunIndexModelEntry): Record<string, unknown> {
  return {
    run_id: entry.runId,
    model: entry.model,
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

function dbToPm(row: DbRunModel): RunIndexModelEntry {
  return {
    runId: String(row.run_id ?? ''),
    model: String(row.model ?? ''),
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

export async function loadRunIndex(): Promise<RunIndexFile> {
  return { runs: await listRuns() };
}

export async function listRuns(): Promise<RunIndexRecord[]> {
  const db = getDrizzleDb();
  const rows: DbRun[] = await db.select().from(runs).orderBy(desc(runs.started_at));
  const allPm: DbRunModel[] = await db.select().from(run_models).orderBy(run_models.run_id);
  const pmByRun = groupPerModel(allPm);
  return rows.map((r: DbRun) => toRunRecord(r, pmByRun.get(String(r.run_id)) ?? []));
}

/** Statuses the live dashboard must always see regardless of age. */
const LIVE_RUN_STATUSES = ['running', 'finalizing', 'stopped'];
/** Completed/errored runs stay visible for this long after they start. */
export const LIVE_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded live feed: every non-completed (active) run plus runs started within
 * the recent window, with per-model rows loaded only for those runs. Polling
 * the full `runs`/`run_models` tables every couple of seconds does not scale
 * with run history.
 */
export async function listLiveRuns(recentWindowMs: number = LIVE_RUN_WINDOW_MS): Promise<RunIndexRecord[]> {
  const db = getDrizzleDb();
  const cutoff = new Date(Date.now() - recentWindowMs).toISOString();
  const rows: DbRun[] = await db.select().from(runs)
    .where(or(inArray(runs.status, LIVE_RUN_STATUSES), gte(runs.started_at, cutoff)))
    .orderBy(desc(runs.started_at));
  if (rows.length === 0) return [];
  const runIds = rows.map((r: DbRun) => String(r.run_id));
  const allPm: DbRunModel[] = await db.select().from(run_models).where(chunkedIn(run_models.run_id, runIds));
  const pmByRun = groupPerModel(allPm);
  return rows.map((r: DbRun) => toRunRecord(r, pmByRun.get(String(r.run_id)) ?? []));
}

function groupPerModel(rows: DbRunModel[]): Map<string, DbRunModel[]> {
  const byRun = new Map<string, DbRunModel[]>();
  for (const pm of rows) {
    const rid = String(pm.run_id);
    let list = byRun.get(rid);
    if (!list) { list = []; byRun.set(rid, list); }
    list.push(pm);
  }
  return byRun;
}

function toRunRecord(r: DbRun, perModel: DbRunModel[]): RunIndexRecord {
  return {
    runId: String(r.run_id),
    scenario: String(r.scenario),
    models: JSON.parse(String(r.models)) as string[],
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    status: String(r.status) as RunIndexRecord['status'],
    source: String(r.source) as RunIndexRecord['source'],
    perModel: perModel.map(dbToPm),
    comparisonMdPath: r.comparison_md_path ? String(r.comparison_md_path) : null,
    comparisonJsonPath: r.comparison_json_path ? String(r.comparison_json_path) : null,
    createdBy: r.created_by ? String(r.created_by) : undefined,
    reapedAt: r.reaped_at ? String(r.reaped_at) : null,
  };
}

export async function getRunRecord(runId: string): Promise<RunIndexRecord | undefined> {
  const db = getDrizzleDb();
  const rows: DbRun[] = await db.select().from(runs).where(eq(runs.run_id, runId)).limit(1);
  if (rows.length === 0) return undefined;
  const r = rows[0]!;
  const perModel: DbRunModel[] = await db.select().from(run_models).where(eq(run_models.run_id, runId));
  return {
    runId: String(r.run_id),
    scenario: String(r.scenario),
    models: JSON.parse(String(r.models)) as string[],
    startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    status: String(r.status) as RunIndexRecord['status'],
    source: String(r.source) as RunIndexRecord['source'],
    perModel: perModel.map(dbToPm),
    comparisonMdPath: r.comparison_md_path ? String(r.comparison_md_path) : null,
    comparisonJsonPath: r.comparison_json_path ? String(r.comparison_json_path) : null,
    createdBy: r.created_by ? String(r.created_by) : undefined,
    reapedAt: r.reaped_at ? String(r.reaped_at) : null,
  };
}

export async function upsertRun(record: RunIndexRecord): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(runs).values({
    run_id: record.runId,
    scenario: record.scenario,
    models: JSON.stringify(record.models),
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    status: record.status,
    source: record.source,
    comparison_md_path: record.comparisonMdPath,
    comparison_json_path: record.comparisonJsonPath,
    created_by: record.createdBy ?? null,
    reaped_at: record.reapedAt ?? null,
  }).onConflictDoUpdate({
    target: runs.run_id,
    set: {
      scenario: record.scenario,
      models: JSON.stringify(record.models),
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      status: record.status,
      source: record.source,
      comparison_md_path: record.comparisonMdPath,
      comparison_json_path: record.comparisonJsonPath,
      created_by: record.createdBy ?? null,
      reaped_at: record.reapedAt ?? null,
    },
  });
  if (record.perModel && record.perModel.length > 0) {
    for (const pm of record.perModel) {
      await db.insert(run_models).values(pmToDb(pm)).onConflictDoUpdate({
        target: [run_models.run_id, run_models.model],
        set: {
          output_dir: pm.outputDir,
          sandbox_dir: pm.sandboxDir,
          result_path: pm.resultPath,
          conversation_path: pm.conversationPath,
          report_path: pm.reportPath,
          log_file: pm.logFile,
          status: pm.status,
          success: pm.success != null ? (pm.success ? 1 : 0) : null,
          turns_used: pm.turnsUsed ?? null,
          total_tool_calls: pm.totalToolCalls ?? null,
          stop_reason: pm.stopReason ?? null,
          duration_ms: pm.durationMs ?? null,
        },
      });
    }
  }
}

export async function updateRun(
  runId: string,
  mutator: (rec: RunIndexRecord) => void,
): Promise<RunIndexRecord | undefined> {
  const rec = await getRunRecord(runId);
  if (!rec) return undefined;
  mutator(rec);
  await upsertRun(rec);
  return rec;
}
