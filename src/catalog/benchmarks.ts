import type { Database } from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { ModelbenchResponseSchema, type ModelbenchResponse, ZeroEvalModelSchema } from './types.js';
import { matchModelToCanonical, type CatalogEntry } from './match.js';
import type { SyncResult } from './sync.js';

const MODELBENCH_API = 'https://modelbench.lol/api/v1/models';
const ZEROEVAL_API = 'https://api.zeroeval.com/leaderboard/models/full';
const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const PREFERRED_MODELBENCH = new Set(['Intelligence Index', 'Coding Score', 'Agentic Score', 'Speed TPS']);
const ZEROEVAL_BENCH_MAP: Record<string, string> = {
  swebench: 'SWE-bench', gpqa: 'GPQA Diamond', mmlu: 'MMLU', humaneval: 'HumanEval', math: 'MATH',
};

export interface BenchmarkOpts {
  force?: boolean;
}

export async function fetchBenchmarks(source: 'modelbench' | 'zeroeval', _opts: BenchmarkOpts = {}): Promise<SyncResult> {
  const db = getDb();
  try {
    const catalog = db.prepare('SELECT id, name, provider_id FROM models').all() as CatalogEntry[];
    let count: number;
    if (source === 'modelbench') count = await fetchModelbench(db, catalog);
    else count = await fetchZeroEval(db, catalog);
    updateCacheState(db, source, 'ok', undefined, count);
    return { source, ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCacheState(db, source, 'error', msg, 0);
    return { source, ok: false, count: 0, error: msg };
  }
}

async function fetchModelbench(db: Database, catalog: CatalogEntry[]): Promise<number> {
  const upsertBenchmark = db.prepare(`
    INSERT INTO benchmarks (model_id, benchmark, source, score, measured_at, source_url, is_preferred)
    VALUES (@model_id, @benchmark, @source, @score, @measured_at, @source_url, @is_preferred)
    ON CONFLICT(model_id, benchmark, source) DO UPDATE SET
      score=@score, measured_at=@measured_at, source_url=@source_url, is_preferred=@is_preferred
  `);
  const now = new Date().toISOString();
  let count = 0;
  let page = 1;
  const limit = 50;
  let total = Infinity;
  const fields = 'slug,name,intelligence_score,coding_score,agentic_score,speed_tps,benchmark_data,source';
  while (page <= Math.ceil(total / limit) && page <= 20) {
    const url = `${MODELBENCH_API}?limit=${limit}&page=${page}&fields=${fields}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`modelbench ${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelbenchResponseSchema.parse(raw) as ModelbenchResponse;
    total = parsed.meta?.total ?? parsed.data.length;
    const tx = db.transaction(() => {
      for (const m of parsed.data) {
        const canonicalId = matchModelToCanonical(undefined, undefined, catalog, m.name);
        if (!canonicalId) continue;
        const benchmarks: Array<[string, number]> = [];
        if (m.intelligence_score !== undefined) benchmarks.push(['Intelligence Index', m.intelligence_score]);
        if (m.coding_score !== undefined) benchmarks.push(['Coding Score', m.coding_score]);
        if (m.agentic_score !== undefined) benchmarks.push(['Agentic Score', m.agentic_score]);
        if (m.speed_tps !== undefined) benchmarks.push(['Speed TPS', m.speed_tps]);
        if (m.benchmark_data) {
          for (const [k, v] of Object.entries(m.benchmark_data)) {
            if (typeof v === 'number' && !benchmarks.some(b => b[0] === k)) benchmarks.push([k, v]);
          }
        }
        for (const [name, score] of benchmarks) {
          upsertBenchmark.run({
            model_id: canonicalId, benchmark: name, source: 'modelbench', score,
            measured_at: now, source_url: m.source ?? null,
            is_preferred: PREFERRED_MODELBENCH.has(name) ? 1 : 0,
          });
          count++;
        }
      }
    });
    tx();
    page++;
  }
  return count;
}

async function fetchZeroEval(db: Database, catalog: CatalogEntry[]): Promise<number> {
  const upsertBenchmark = db.prepare(`
    INSERT INTO benchmarks (model_id, benchmark, source, score, measured_at, source_url, is_preferred)
    VALUES (@model_id, @benchmark, @source, @score, @measured_at, @source_url, @is_preferred)
    ON CONFLICT(model_id, benchmark, source) DO UPDATE SET
      score=@score, measured_at=@measured_at, source_url=@source_url, is_preferred=@is_preferred
  `);
  const now = new Date().toISOString();
  let count = 0;
  const res = await fetch(ZEROEVAL_API);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`zeroeval ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = await res.json();
  const parsed = ZeroEvalModelSchema.parse(raw) as Record<string, Record<string, unknown>>;
  const tx = db.transaction(() => {
    for (const [modelKey, fields] of Object.entries(parsed)) {
      const modelName = typeof fields.model_name === 'string' ? fields.model_name : modelKey;
      const canonicalId = matchModelToCanonical(undefined, undefined, catalog, modelName);
      if (!canonicalId) continue;
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'model_name' || k === 'model_id') continue;
        if (typeof v !== 'number') continue;
        const benchName = ZEROEVAL_BENCH_MAP[k.toLowerCase()] ?? k;
        upsertBenchmark.run({
          model_id: canonicalId, benchmark: benchName, source: 'zeroeval', score: v,
          measured_at: now, source_url: null, is_preferred: 0,
        });
        count++;
      }
    }
  });
  tx();
  return count;
}

function updateCacheState(db: Database, source: string, status: string, error: string | undefined, count: number): void {
  const now = new Date();
  const next = new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString();
  db.prepare(`
    INSERT INTO catalog_cache_state (source, last_fetch, last_status, last_error, count, next_refresh)
    VALUES (@source, @last_fetch, @last_status, @last_error, @count, @next_refresh)
    ON CONFLICT(source) DO UPDATE SET
      last_fetch=@last_fetch, last_status=@last_status, last_error=@last_error, count=@count, next_refresh=@next_refresh
  `).run({
    source, last_fetch: now.toISOString(), last_status: status,
    last_error: error ?? null, count, next_refresh: next,
  });
}
