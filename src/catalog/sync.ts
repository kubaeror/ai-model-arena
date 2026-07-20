import type { Database } from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { ModelsDevResponseSchema, type ModelsDevResponse } from './types.js';
import { normalizeModelId } from './match.js';

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
  const db = getDb();
  try {
    const res = await fetch(opts.apiUrl);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelsDevResponseSchema.parse(raw) as ModelsDevResponse;
    const count = upsertCatalog(db, parsed);
    updateCacheState(db, 'models.dev', 'ok', undefined, count);
    return { source: 'models.dev', ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCacheState(db, 'models.dev', 'error', msg, 0);
    return { source: 'models.dev', ok: false, count: 0, error: msg };
  }
}

function upsertCatalog(db: Database, data: ModelsDevResponse): number {
  const now = new Date().toISOString();
  let modelCount = 0;
  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, name, api_base, auth_scheme, env_var, is_builtin, adapter, header_name, created_at, updated_at)
    VALUES (@id, @name, NULL, @auth_scheme, @env_var, 1, @adapter, NULL, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, env_var=@env_var, adapter=@adapter, updated_at=@updated_at
  `);
  const upsertModel = db.prepare(`
    INSERT INTO models (id, name, family, provider_id, release_date, attachment, reasoning, temperature, tool_call,
      interleaved, status, context_limit, input_limit, output_limit, modalities, reasoning_options, source_json, last_synced_at)
    VALUES (@id, @name, @family, @provider_id, @release_date, @attachment, @reasoning, @temperature, @tool_call,
      @interleaved, @status, @context_limit, @input_limit, @output_limit, @modalities, @reasoning_options, @source_json, @last_synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, family=@family, release_date=@release_date, attachment=@attachment, reasoning=@reasoning,
      temperature=@temperature, tool_call=@tool_call, interleaved=@interleaved, status=@status,
      context_limit=@context_limit, input_limit=@input_limit, output_limit=@output_limit,
      modalities=@modalities, reasoning_options=@reasoning_options, source_json=@source_json, last_synced_at=@last_synced_at
  `);
  const upsertModelProvider = db.prepare(`
    INSERT INTO model_providers (model_id, provider_id, api_model_id) VALUES (@model_id, @provider_id, @api_model_id)
    ON CONFLICT(model_id, provider_id) DO UPDATE SET api_model_id=@api_model_id
  `);
  const upsertPricing = db.prepare(`
    INSERT INTO pricing (model_id, input, output, cache_read, cache_write, tier_size, over_200k_input, over_200k_output, over_200k_cache_read, over_200k_cache_write, updated_at)
    VALUES (@model_id, @input, @output, @cache_read, @cache_write, NULL, @over_200k_input, @over_200k_output, @over_200k_cache_read, @over_200k_cache_write, @updated_at)
    ON CONFLICT(model_id, tier_size) DO UPDATE SET
      input=@input, output=@output, cache_read=@cache_read, cache_write=@cache_write,
      over_200k_input=@over_200k_input, over_200k_output=@over_200k_output,
      over_200k_cache_read=@over_200k_cache_read, over_200k_cache_write=@over_200k_cache_write, updated_at=@updated_at
  `);

  const tx = db.transaction(() => {
    for (const [providerId, provider] of Object.entries(data)) {
      const adapter = PROVIDER_ADAPTER_MAP[providerId] ?? 'openai-compat';
      const authScheme = providerId === 'anthropic' ? 'x-api-key' : providerId.startsWith('google') ? 'google' : providerId === 'amazon-bedrock' ? 'bedrock' : 'bearer';
      upsertProvider.run({
        id: providerId, name: provider.name, auth_scheme: authScheme,
        env_var: provider.env[0] ?? null, adapter, created_at: now, updated_at: now,
      });
      for (const [modelId, model] of Object.entries(provider.models)) {
        const canonicalId = normalizeModelId(modelId, providerId);
        upsertModel.run({
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
        upsertModelProvider.run({ model_id: canonicalId, provider_id: providerId, api_model_id: modelId });
        const cost = model.cost ?? {};
        upsertPricing.run({
          model_id: canonicalId,
          input: cost.input ?? null, output: cost.output ?? null,
          cache_read: cost.cache_read ?? null, cache_write: cost.cache_write ?? null,
          over_200k_input: cost.context_over_200k?.input ?? null,
          over_200k_output: cost.context_over_200k?.output ?? null,
          over_200k_cache_read: cost.context_over_200k?.cache_read ?? null,
          over_200k_cache_write: cost.context_over_200k?.cache_write ?? null,
          updated_at: now,
        });
        modelCount++;
      }
    }
  });
  tx();
  return modelCount;
}

function updateCacheState(db: Database, source: string, status: string, error: string | undefined, count: number): void {
  const now = new Date();
  const next = new Date(now.getTime() + getRefreshIntervalMs()).toISOString();
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
