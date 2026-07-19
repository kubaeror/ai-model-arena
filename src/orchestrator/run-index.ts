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

// ── In-process cache (300 ms TTL) ─────────────────────────────────────────
interface IndexCache { data: RunIndexFile; ts: number; }
let _cache: IndexCache | null = null;
const CACHE_TTL_MS = 300;

function invalidateCache(): void { _cache = null; }

// ── Async write lock ───────────────────────────────────────────────────────
let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => T): Promise<T> {
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return fn();
  } finally {
    release();
  }
}

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
}

export interface RunIndexFile {
  runs: RunIndexRecord[];
}

export function indexPath(): string {
  return path.join(findProjectRoot(), 'outputs', 'runs-index.json');
}

export function loadRunIndex(): RunIndexFile {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) return _cache.data;
  const p = indexPath();
  if (!fs.existsSync(p)) {
    _cache = { data: { runs: [] }, ts: now };
    return _cache.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as RunIndexFile;
    const valid = data && Array.isArray(data.runs) ? data : { runs: [] };
    _cache = { data: valid, ts: now };
    return valid;
  } catch {
    _cache = { data: { runs: [] }, ts: now };
    return _cache.data;
  }
}

export function saveRunIndex(idx: RunIndexFile): void {
  invalidateCache();
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
export async function upsertRun(record: RunIndexRecord): Promise<void> {
  await withWriteLock(() => {
    const idx = loadRunIndex();
    const i = idx.runs.findIndex((r) => r.runId === record.runId);
    if (i >= 0) idx.runs[i] = record;
    else idx.runs.unshift(record);
    saveRunIndex(idx);
  });
}

/** Apply a mutating function to a record, then persist. */
export async function updateRun(
  runId: string,
  mutator: (rec: RunIndexRecord) => void,
): Promise<RunIndexRecord | undefined> {
  return await withWriteLock(() => {
    const idx = loadRunIndex();
    const rec = idx.runs.find((r) => r.runId === runId);
    if (!rec) return undefined;
    mutator(rec);
    saveRunIndex(idx);
    return rec;
  });
}
