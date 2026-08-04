import { getDrizzleDb } from '../db/index.js';
import { ModelsDevResponseSchema, type ModelsDevResponse } from './types.js';
import { normalizeModelId } from './match.js';
import {
  providers, models, model_providers, pricing,
  pricing_snapshots, catalog_cache_state,
} from '../db/schema.js';

export interface SyncResult {
  source: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface SyncOpts {
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

function getApiUrl(): string {
  return process.env.MODELS_DEV_API_URL ?? DEFAULT_API_URL;
}
function getRefreshIntervalMs(): number {
  const days = Number(process.env.CATALOG_REFRESH_INTERVAL_DAYS ?? '30');
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}

export async function fetchSync(source: 'models.dev', opts: SyncOpts = { apiUrl: getApiUrl() }): Promise<SyncResult> {
  void source;
  const db = getDrizzleDb();
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
    return { source: 'models.dev', ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateCacheState(db, 'models.dev', 'error', msg, 0);
    return { source: 'models.dev', ok: false, count: 0, error: msg };
  }
}

async function upsertCatalog(db: any, data: ModelsDevResponse): Promise<number> {
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
      await db.insert(pricing).values({
        model_id: canonicalId,
        input: cost.input ?? null, output: cost.output ?? null,
        cache_read: cost.cache_read ?? null, cache_write: cost.cache_write ?? null,
        tier_size: 0,
        over_200k_input: cost.context_over_200k?.input ?? null,
        over_200k_output: cost.context_over_200k?.output ?? null,
        over_200k_cache_read: cost.context_over_200k?.cache_read ?? null,
        over_200k_cache_write: cost.context_over_200k?.cache_write ?? null,
        updated_at: now,
      }).onConflictDoUpdate({
        target: [pricing.model_id, pricing.tier_size],
        set: {
          input: cost.input ?? null, output: cost.output ?? null,
          cache_read: cost.cache_read ?? null, cache_write: cost.cache_write ?? null,
          over_200k_input: cost.context_over_200k?.input ?? null,
          over_200k_output: cost.context_over_200k?.output ?? null,
          over_200k_cache_read: cost.context_over_200k?.cache_read ?? null,
          over_200k_cache_write: cost.context_over_200k?.cache_write ?? null,
          updated_at: now,
        },
      });
      modelCount++;
    }
  }

  await capturePricingSnapshot(db, now);
  return modelCount;
}

async function capturePricingSnapshot(db: any, version: string): Promise<void> {
  const rows: any[] = await db.select().from(pricing);
  for (const r of rows) {
    await db.insert(pricing_snapshots).values({
      version,
      model_id: r.model_id,
      input: r.input, output: r.output,
      cache_read: r.cache_read, cache_write: r.cache_write,
      tier_size: 0,
      over_200k_input: r.over_200k_input, over_200k_output: r.over_200k_output,
      over_200k_cache_read: r.over_200k_cache_read, over_200k_cache_write: r.over_200k_cache_write,
      snapshot_at: version,
    });
  }
}

async function updateCacheState(db: any, source: string, status: string, error: string | undefined, count: number): Promise<void> {
  const now = new Date();
  const next = new Date(now.getTime() + getRefreshIntervalMs()).toISOString();
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
