import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../paths.js';

/**
 * Lightweight run metadata index persisted as a single JSON file
 * (outputs/runs-index.json). This is the single source of truth the dashboard
 * uses to list runs without scanning the filesystem, and to map PM2 process
 * names back to (runId, model, scenario). Workers themselves are stateless and
 * always read/write through the filesystem (outputs/) — this index only holds
 * metadata/paths, never conversation state.
 */

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
  source: 'cli' | 'dashboard';
  perModel: RunIndexModelEntry[];
  comparisonMdPath: string | null;
  comparisonJsonPath: string | null;
}

export interface RunIndexFile {
  runs: RunIndexRecord[];
}

export function indexPath(): string {
  return path.join(findProjectRoot(), 'outputs', 'runs-index.json');
}

export function loadRunIndex(): RunIndexFile {
  const p = indexPath();
  if (!fs.existsSync(p)) return { runs: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as RunIndexFile;
    return data && Array.isArray(data.runs) ? data : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

export function saveRunIndex(idx: RunIndexFile): void {
  const p = indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(idx, null, 2));
}

export function listRuns(): RunIndexRecord[] {
  // Newest first.
  return loadRunIndex().runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getRunRecord(runId: string): RunIndexRecord | undefined {
  return loadRunIndex().runs.find((r) => r.runId === runId);
}

/** Insert or replace a record by runId. */
export function upsertRun(record: RunIndexRecord): void {
  const idx = loadRunIndex();
  const i = idx.runs.findIndex((r) => r.runId === record.runId);
  if (i >= 0) idx.runs[i] = record;
  else idx.runs.unshift(record);
  saveRunIndex(idx);
}

/** Apply a mutating function to a record, then persist. */
export function updateRun(runId: string, mutator: (rec: RunIndexRecord) => void): RunIndexRecord | undefined {
  const idx = loadRunIndex();
  const rec = idx.runs.find((r) => r.runId === runId);
  if (!rec) return undefined;
  mutator(rec);
  saveRunIndex(idx);
  return rec;
}
