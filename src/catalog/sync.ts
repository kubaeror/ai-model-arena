import { eq, lt, sql } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { getDrizzleDb, getDriver } from '../db/index.js';
import { isStale } from './cache.js';
import { ModelsDevResponseSchema, type ModelsDevResponse } from './types.js';
import { normalizeModelId } from './match.js';
import { validateProviderUrl } from '../providers/url-validator.js';
import { resetPricingCache } from '../cost-tracking/pricing.js';
import {
  providers, models, model_providers, pricing,
  pricing_snapshots, catalog_cache_state,
} from '../db/schema.js';
import type { DbPricing } from '../db/schema.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export interface SyncResult {
  source: string;
  ok: boolean;
  count: number;
  skipped?: boolean;
  error?: string;
}

interface SyncOpts {
  apiUrl: string;
  force?: boolean;
}

const PROVIDER_ADAPTER_MAP: Record<string, 'openai-compat' | 'anthropic' | 'google' | 'bedrock'> = {
  anthropic: 'anthropic',
  google: 'google',
  'google-vertex': 'google',
  'google-vertex-anthropic': 'anthropic',
  'amazon-bedrock': 'bedrock',
};

const DEFAULT_API_URL = 'https://models.dev/api.json';

const DEFAULT_REFRESH_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Keep each INSERT well under SQLite's bound-variable limit. */
const MAX_ROWS_PER_INSERT = 50;
/** Pricing snapshots older than this are pruned on every refresh. */
const SNAPSHOT_RETENTION_DAYS = 90;

type ProviderInsert = InferInsertModel<typeof providers>;
type ModelInsert = InferInsertModel<typeof models>;
type ModelProviderInsert = InferInsertModel<typeof model_providers>;
type PricingInsert = InferInsertModel<typeof pricing>;
type PricingSnapshotInsert = InferInsertModel<typeof pricing_snapshots>;

interface CatalogPlan {
  providers: ProviderInsert[];
  models: ModelInsert[];
  modelProviders: ModelProviderInsert[];
  pricing: PricingInsert[];
  modelCount: number;
}

/** Drizzle query builders are thenable; the sync driver also exposes run(). */
type BatchQuery = PromiseLike<unknown> & { run(): unknown };
type CatalogStatement = (tx: BetterSQLite3Database) => BatchQuery;

function getApiUrl(): string {
  return process.env.MODELS_DEV_API_URL ?? DEFAULT_API_URL;
}
export function refreshIntervalDays(): number {
  const days = Number(process.env.CATALOG_REFRESH_DAYS ?? String(DEFAULT_REFRESH_DAYS));
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_REFRESH_DAYS;
}
export function refreshIntervalMs(): number {
  return refreshIntervalDays() * MS_PER_DAY;
}

export async function fetchSync(source: 'models.dev', opts: SyncOpts = { apiUrl: getApiUrl() }): Promise<SyncResult> {
  void source;
  const db = getDrizzleDb();
  if (!opts.force && !(await isStale('models.dev'))) {
    return { source: 'models.dev', ok: true, count: 0, skipped: true };
  }
  try {
    const res = await fetch(opts.apiUrl);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelsDevResponseSchema.parse(raw) as ModelsDevResponse;
    const count = await upsertCatalog(db, parsed);
    await updateCacheState(db, 'models.dev', 'ok', undefined, count);
    if (count > 0) resetPricingCache();
    return { source: 'models.dev', ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateCacheState(db, 'models.dev', 'error', msg, 0);
    return { source: 'models.dev', ok: false, count: 0, error: msg };
  }
}

function chunkRows<T>(rows: T[]): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    batches.push(rows.slice(i, i + MAX_ROWS_PER_INSERT));
  }
  return batches;
}

function buildCatalogPlan(data: ModelsDevResponse, now: string): CatalogPlan {
  const plan: CatalogPlan = { providers: [], models: [], modelProviders: [], pricing: [], modelCount: 0 };

  for (const [providerId, provider] of Object.entries(data)) {
    const adapter = PROVIDER_ADAPTER_MAP[providerId] ?? 'openai-compat';
    const authScheme = providerId === 'anthropic' ? 'x-api-key' : providerId.startsWith('google') ? 'google' : providerId === 'amazon-bedrock' ? 'bedrock' : 'bearer';
    // models.dev is remote input: only persist an endpoint that passes the same
    // SSRF gate as dashboard-created providers (the registry re-validates too).
    const apiBase = provider.api && validateProviderUrl(provider.api).ok ? provider.api : null;
    plan.providers.push({
      id: providerId, name: provider.name,
      api_base: apiBase, auth_scheme: authScheme,
      env_var: provider.env[0] ?? null, is_builtin: 1, adapter,
      header_name: null, created_at: now, updated_at: now,
    });

    for (const [modelId, model] of Object.entries(provider.models)) {
      const canonicalId = normalizeModelId(modelId, providerId);
      plan.models.push({
        id: canonicalId, name: model.name, family: model.family ?? null,
        provider_id: providerId, release_date: model.release_date ?? null,
        attachment: model.attachment ? 1 : 0, reasoning: model.reasoning ? 1 : 0,
        temperature: model.temperature ? 1 : 0, tool_call: model.tool_call ? 1 : 0,
        interleaved: typeof model.interleaved === 'object' ? model.interleaved.field : (model.interleaved ? 'reasoning' : null),
        status: model.status ?? null,
        context_limit: model.limit.context, input_limit: model.limit.input ?? null, output_limit: model.limit.output,
        modalities: model.modalities ? JSON.stringify(model.modalities) : null,
        reasoning_options: model.reasoning_options ? JSON.stringify(model.reasoning_options) : null,
        source_json: JSON.stringify(model), last_synced_at: now,
      });

      plan.modelProviders.push({
        model_id: canonicalId, provider_id: providerId, api_model_id: modelId,
      });

      const cost = model.cost ?? {};
      const contextOver200k = cost.context_over_200k;
      plan.pricing.push({
        model_id: canonicalId, tier_size: 0,
        input: cost.input ?? null, output: cost.output ?? null,
        cache_read: cost.cache_read ?? null, cache_write: cost.cache_write ?? null,
        over_200k_input: contextOver200k?.input ?? null,
        over_200k_output: contextOver200k?.output ?? null,
        over_200k_cache_read: contextOver200k?.cache_read ?? null,
        over_200k_cache_write: contextOver200k?.cache_write ?? null,
        updated_at: now,
      });
      for (const tier of cost.tiers ?? []) {
        plan.pricing.push({
          model_id: canonicalId, tier_size: tier.tier.size,
          input: tier.input, output: tier.output,
          cache_read: tier.cache_read ?? null, cache_write: tier.cache_write ?? null,
          over_200k_input: null, over_200k_output: null,
          over_200k_cache_read: null, over_200k_cache_write: null,
          updated_at: now,
        });
      }
      plan.modelCount++;
    }
  }
  // A batched INSERT ... ON CONFLICT cannot update the same row twice in one
  // statement (Postgres rejects it; SQLite happens to tolerate it), so collapse
  // duplicate (model_id, tier_size) rows with last-write-wins semantics.
  const uniquePricing = new Map<string, PricingInsert>();
  for (const row of plan.pricing) uniquePricing.set(`${row.model_id}:${row.tier_size}`, row);
  plan.pricing = [...uniquePricing.values()];
  return plan;
}

function buildStatements(plan: CatalogPlan): CatalogStatement[] {
  const statements: CatalogStatement[] = [];
  for (const rows of chunkRows(plan.providers)) {
    statements.push((tx) => tx.insert(providers).values(rows).onConflictDoUpdate({
      target: providers.id,
      set: {
        name: sql`excluded.name`, api_base: sql`excluded.api_base`,
        env_var: sql`excluded.env_var`, adapter: sql`excluded.adapter`,
        updated_at: sql`excluded.updated_at`,
      },
      // Never let the catalog clobber a user-created provider that happens to
      // share an id with a models.dev entry.
      setWhere: eq(providers.is_builtin, 1),
    }) as BatchQuery);
  }
  for (const rows of chunkRows(plan.models)) {
    statements.push((tx) => tx.insert(models).values(rows).onConflictDoUpdate({
      target: models.id,
      set: {
        name: sql`excluded.name`, family: sql`excluded.family`,
        release_date: sql`excluded.release_date`, attachment: sql`excluded.attachment`,
        reasoning: sql`excluded.reasoning`, temperature: sql`excluded.temperature`,
        tool_call: sql`excluded.tool_call`, interleaved: sql`excluded.interleaved`,
        status: sql`excluded.status`, context_limit: sql`excluded.context_limit`,
        input_limit: sql`excluded.input_limit`, output_limit: sql`excluded.output_limit`,
        modalities: sql`excluded.modalities`, reasoning_options: sql`excluded.reasoning_options`,
        source_json: sql`excluded.source_json`, last_synced_at: sql`excluded.last_synced_at`,
      },
    }) as BatchQuery);
  }
  for (const rows of chunkRows(plan.modelProviders)) {
    statements.push((tx) => tx.insert(model_providers).values(rows).onConflictDoUpdate({
      target: [model_providers.model_id, model_providers.provider_id],
      set: { api_model_id: sql`excluded.api_model_id` },
    }) as BatchQuery);
  }
  for (const rows of chunkRows(plan.pricing)) {
    statements.push((tx) => tx.insert(pricing).values(rows).onConflictDoUpdate({
      target: [pricing.model_id, pricing.tier_size],
      set: {
        input: sql`excluded.input`, output: sql`excluded.output`,
        cache_read: sql`excluded.cache_read`, cache_write: sql`excluded.cache_write`,
        over_200k_input: sql`excluded.over_200k_input`, over_200k_output: sql`excluded.over_200k_output`,
        over_200k_cache_read: sql`excluded.over_200k_cache_read`, over_200k_cache_write: sql`excluded.over_200k_cache_write`,
        updated_at: sql`excluded.updated_at`,
      },
    }) as BatchQuery);
  }
  return statements;
}

function runStatementsSync(tx: BetterSQLite3Database, statements: CatalogStatement[]): void {
  for (const statement of statements) statement(tx).run();
}

async function runStatementsAsync(tx: BetterSQLite3Database, statements: CatalogStatement[]): Promise<void> {
  for (const statement of statements) await statement(tx);
}

async function upsertCatalog(db: BetterSQLite3Database, data: ModelsDevResponse): Promise<number> {
  const now = new Date().toISOString();
  const plan = buildCatalogPlan(data, now);
  const statements = buildStatements(plan);

  if (getDriver() === 'sqlite') {
    // better-sqlite3 rejects a transaction callback that returns a promise, so
    // the batched statements run synchronously through Drizzle's run().
    db.transaction((tx) => {
      runStatementsSync(tx as unknown as BetterSQLite3Database, statements);
    });
  } else {
    await db.transaction(async (tx) => {
      await runStatementsAsync(tx as unknown as BetterSQLite3Database, statements);
    });
  }

  await capturePricingSnapshot(db, now);
  await prunePricingSnapshots(db, now);
  return plan.modelCount;
}

async function capturePricingSnapshot(db: BetterSQLite3Database, version: string): Promise<void> {
  const rows: DbPricing[] = await db.select().from(pricing);
  const snapshots: PricingSnapshotInsert[] = rows.map((r) => ({
    version,
    model_id: r.model_id,
    input: r.input, output: r.output,
    cache_read: r.cache_read, cache_write: r.cache_write,
    tier_size: r.tier_size,
    over_200k_input: r.over_200k_input, over_200k_output: r.over_200k_output,
    over_200k_cache_read: r.over_200k_cache_read, over_200k_cache_write: r.over_200k_cache_write,
    snapshot_at: version,
  }));
  for (const batch of chunkRows(snapshots)) {
    await db.insert(pricing_snapshots).values(batch);
  }
}

/** Bound snapshot growth: each refresh used to append forever. */
async function prunePricingSnapshots(db: BetterSQLite3Database, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - SNAPSHOT_RETENTION_DAYS * MS_PER_DAY).toISOString();
  await db.delete(pricing_snapshots).where(lt(pricing_snapshots.snapshot_at, cutoff));
}

async function updateCacheState(db: BetterSQLite3Database, source: string, status: string, error: string | undefined, count: number): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + refreshIntervalMs()).toISOString();
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
