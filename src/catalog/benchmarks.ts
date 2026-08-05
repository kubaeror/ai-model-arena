import { getDrizzleDb } from '../db/index.js';
import { benchmarks, catalog_cache_state, models } from '../db/schema.js';
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
  const db = getDrizzleDb();
  try {
    const catalogRows: any[] = await db.select({ id: models.id, name: models.name, provider_id: models.provider_id }).from(models);
    const catalog = catalogRows.map(r => ({ id: r.id, name: r.name, provider_id: r.provider_id })) as CatalogEntry[];
    let count: number;
    if (source === 'modelbench') count = await fetchModelbench(db, catalog);
    else count = await fetchZeroEval(db, catalog);
    await updateCacheState(db, source, 'ok', undefined, count);
    return { source, ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateCacheState(db, source, 'error', msg, 0);
    return { source, ok: false, count: 0, error: msg };
  }
}

async function fetchModelbench(db: any, catalog: CatalogEntry[]): Promise<number> {
  const now = new Date().toISOString();
  let count = 0;
  let page = 1;
  const limit = 50;
  const maxModels = 10_000;
  const fields = 'slug,name,intelligence_score,coding_score,agentic_score,speed_tps,benchmark_data,source';
  while (page * limit <= maxModels) {
    const url = `${MODELBENCH_API}?limit=${limit}&page=${page}&fields=${fields}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`modelbench ${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelbenchResponseSchema.parse(raw) as ModelbenchResponse;
    for (const m of parsed.data) {
      const canonicalId = matchModelToCanonical(undefined, undefined, catalog, m.name);
      if (!canonicalId) continue;
      const benchEntries: Array<[string, number]> = [];
      if (m.intelligence_score !== undefined) benchEntries.push(['Intelligence Index', m.intelligence_score]);
      if (m.coding_score !== undefined) benchEntries.push(['Coding Score', m.coding_score]);
      if (m.agentic_score !== undefined) benchEntries.push(['Agentic Score', m.agentic_score]);
      if (m.speed_tps !== undefined) benchEntries.push(['Speed TPS', m.speed_tps]);
      if (m.benchmark_data) {
        for (const [k, v] of Object.entries(m.benchmark_data)) {
          if (typeof v === 'number' && !benchEntries.some(b => b[0] === k)) benchEntries.push([k, v]);
        }
      }
      for (const [name, score] of benchEntries) {
        await db.insert(benchmarks).values({
          model_id: canonicalId, benchmark: name, source: 'modelbench', score,
          measured_at: now, source_url: m.source ?? null,
          is_preferred: PREFERRED_MODELBENCH.has(name) ? 1 : 0,
        }).onConflictDoUpdate({
          target: [benchmarks.model_id, benchmarks.benchmark, benchmarks.source],
          set: { score, measured_at: now, source_url: m.source ?? null, is_preferred: PREFERRED_MODELBENCH.has(name) ? 1 : 0 },
        });
        count++;
      }
    }
    page++;
    if (parsed.data.length < limit) break;
  }
  return count;
}

async function fetchZeroEval(db: any, catalog: CatalogEntry[]): Promise<number> {
  const now = new Date().toISOString();
  let count = 0;
  const res = await fetch(ZEROEVAL_API);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`zeroeval ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = await res.json();
  const parsed = ZeroEvalModelSchema.parse(raw) as Record<string, Record<string, unknown>>;
  for (const [modelKey, fields] of Object.entries(parsed)) {
    const modelName = typeof fields.model_name === 'string' ? fields.model_name : modelKey;
    const canonicalId = matchModelToCanonical(undefined, undefined, catalog, modelName);
    if (!canonicalId) continue;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'model_name' || k === 'model_id') continue;
      if (typeof v !== 'number') continue;
      const benchName = ZEROEVAL_BENCH_MAP[k.toLowerCase()] ?? k;
      await db.insert(benchmarks).values({
        model_id: canonicalId, benchmark: benchName, source: 'zeroeval', score: v as number,
        measured_at: now, source_url: null, is_preferred: 0,
      }).onConflictDoUpdate({
        target: [benchmarks.model_id, benchmarks.benchmark, benchmarks.source],
        set: { score: v as number, measured_at: now, source_url: null, is_preferred: 0 },
      });
      count++;
    }
  }
  return count;
}

async function updateCacheState(db: any, source: string, status: string, error: string | undefined, count: number): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString();
  await db.insert(catalog_cache_state).values({
    source, last_fetch: now.toISOString(), last_status: status,
    last_error: error ?? null, count, next_refresh: next,
  }).onConflictDoUpdate({
    target: catalog_cache_state.source,
    set: {
      last_fetch: now.toISOString(), last_status: status,
      last_error: error ?? null, count, next_refresh: next,
    },
  });
}
