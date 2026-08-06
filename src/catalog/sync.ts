import { getDrizzleDb } from '../db/index.js';
import { isStale } from './cache.js';
import { ModelsDevResponseSchema, type ModelsDevResponse } from './types.js';
import { normalizeModelId } from './match.js';
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

async function upsertCatalog(db: BetterSQLite3Database, data: ModelsDevResponse): Promise<number> {
  const now = new Date().toISOString();
  let modelCount = 0;

  for (const [providerId, provider] of Object.entries(data)) {
    const adapter = PROVIDER_ADAPTER_MAP[providerId] ?? 'openai-compat';
    const authScheme = providerId === 'anthropic' ? 'x-api-key' : providerId.startsWith('google') ? 'google' : providerId === 'amazon-bedrock' ? 'bedrock' : 'bearer';
    await db.insert(providers).values({
      id: providerId, name: provider.name,
      api_base: null, auth_scheme: authScheme,
      env_var: provider.env[0] ?? null, is_builtin: 1, adapter,
      header_name: null, created_at: now, updated_at: now,
    }).onConflictDoUpdate({
      target: providers.id,
      set: { name: provider.name, env_var: provider.env[0] ?? null, adapter, updated_at: now },
    });

    for (const [modelId, model] of Object.entries(provider.models)) {
      const canonicalId = normalizeModelId(modelId, providerId);
      await db.insert(models).values({
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
      }).onConflictDoUpdate({
        target: models.id,
        set: {
          name: model.name, family: model.family ?? null,
          release_date: model.release_date ?? null, attachment: model.attachment ? 1 : 0,
          reasoning: model.reasoning ? 1 : 0, temperature: model.temperature ? 1 : 0,
          tool_call: model.tool_call ? 1 : 0,
          interleaved: typeof model.interleaved === 'object' ? model.interleaved.field : (model.interleaved ? 'reasoning' : null),
          status: model.status ?? null, context_limit: model.limit.context,
          input_limit: model.limit.input ?? null, output_limit: model.limit.output,
          modalities: model.modalities ? JSON.stringify(model.modalities) : null,
          reasoning_options: model.reasoning_options ? JSON.stringify(model.reasoning_options) : null,
          source_json: JSON.stringify(model), last_synced_at: now,
        },
      });

      await db.insert(model_providers).values({
        model_id: canonicalId, provider_id: providerId, api_model_id: modelId,
      }).onConflictDoUpdate({
        target: [model_providers.model_id, model_providers.provider_id],
        set: { api_model_id: modelId },
      });

      const cost = model.cost ?? {};
      const contextOver200k = cost.context_over_200k;
      await upsertPricingRow(db, {
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
        await upsertPricingRow(db, {
          model_id: canonicalId, tier_size: tier.tier.size,
          input: tier.input, output: tier.output,
          cache_read: tier.cache_read ?? null, cache_write: tier.cache_write ?? null,
          over_200k_input: null, over_200k_output: null,
          over_200k_cache_read: null, over_200k_cache_write: null,
          updated_at: now,
        });
      }
      modelCount++;
    }
  }

  await capturePricingSnapshot(db, now);
  return modelCount;
}

async function upsertPricingRow(db: BetterSQLite3Database, row: {
  model_id: string; tier_size: number;
  input: number | null; output: number | null;
  cache_read: number | null; cache_write: number | null;
  over_200k_input: number | null; over_200k_output: number | null;
  over_200k_cache_read: number | null; over_200k_cache_write: number | null;
  updated_at: string;
}): Promise<void> {
  await db.insert(pricing).values(row).onConflictDoUpdate({
    target: [pricing.model_id, pricing.tier_size],
    set: {
      input: row.input, output: row.output,
      cache_read: row.cache_read, cache_write: row.cache_write,
      over_200k_input: row.over_200k_input, over_200k_output: row.over_200k_output,
      over_200k_cache_read: row.over_200k_cache_read, over_200k_cache_write: row.over_200k_cache_write,
      updated_at: row.updated_at,
    },
  });
}

async function capturePricingSnapshot(db: BetterSQLite3Database, version: string): Promise<void> {
  const rows: DbPricing[] = await db.select().from(pricing);
  for (const r of rows) {
    await db.insert(pricing_snapshots).values({
      version,
      model_id: r.model_id,
      input: r.input, output: r.output,
      cache_read: r.cache_read, cache_write: r.cache_write,
      tier_size: r.tier_size,
      over_200k_input: r.over_200k_input, over_200k_output: r.over_200k_output,
      over_200k_cache_read: r.over_200k_cache_read, over_200k_cache_write: r.over_200k_cache_write,
      snapshot_at: version,
    });
  }
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
