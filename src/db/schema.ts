import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';

// ── Drizzle table definitions (source of truth for migrations) ────────────

export const _migrations = sqliteTable('_migrations', {
  id: text('id').primaryKey(),
  applied_at: text('applied_at').notNull(),
});

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  api_base: text('api_base'),
  auth_scheme: text('auth_scheme').notNull(),
  env_var: text('env_var'),
  is_builtin: integer('is_builtin').notNull().default(0),
  adapter: text('adapter').notNull(),
  header_name: text('header_name'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const models = sqliteTable('models', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  family: text('family'),
  provider_id: text('provider_id').notNull().references(() => providers.id),
  release_date: text('release_date'),
  attachment: integer('attachment').notNull().default(0),
  reasoning: integer('reasoning').notNull().default(0),
  temperature: integer('temperature').notNull().default(0),
  tool_call: integer('tool_call').notNull().default(0),
  interleaved: text('interleaved'),
  status: text('status'),
  context_limit: integer('context_limit'),
  input_limit: integer('input_limit'),
  output_limit: integer('output_limit'),
  modalities: text('modalities'),
  reasoning_options: text('reasoning_options'),
  source_json: text('source_json'),
  last_synced_at: text('last_synced_at').notNull(),
}, (table) => [
  uniqueIndex('uq_models_provider_name').on(table.provider_id, table.name),
  index('idx_models_provider').on(table.provider_id),
  index('idx_models_reasoning').on(table.reasoning),
]);

export const model_providers = sqliteTable('model_providers', {
  model_id: text('model_id').notNull().references(() => models.id),
  provider_id: text('provider_id').notNull().references(() => providers.id),
  api_model_id: text('api_model_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.model_id, table.provider_id] }),
]);

export const pricing = sqliteTable('pricing', {
  model_id: text('model_id').notNull().references(() => models.id),
  input: real('input'),
  output: real('output'),
  cache_read: real('cache_read'),
  cache_write: real('cache_write'),
  tier_size: integer('tier_size'),
  over_200k_input: real('over_200k_input'),
  over_200k_output: real('over_200k_output'),
  over_200k_cache_read: real('over_200k_cache_read'),
  over_200k_cache_write: real('over_200k_cache_write'),
  updated_at: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.model_id, table.tier_size] }),
]);

export const benchmarks = sqliteTable('benchmarks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  model_id: text('model_id').notNull().references(() => models.id),
  benchmark: text('benchmark').notNull(),
  source: text('source').notNull(),
  score: real('score').notNull(),
  measured_at: text('measured_at').notNull(),
  source_url: text('source_url'),
  is_preferred: integer('is_preferred').notNull().default(0),
}, (table) => [
  uniqueIndex('uq_benchmarks_model_source').on(table.model_id, table.benchmark, table.source),
  index('idx_benchmarks_model').on(table.model_id, table.benchmark),
]);

export const model_runtime_stats = sqliteTable('model_runtime_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  model_id: text('model_id').notNull().references(() => models.id),
  run_id: text('run_id').notNull(),
  latency_p50_ms: integer('latency_p50_ms'),
  latency_p95_ms: integer('latency_p95_ms'),
  tps: real('tps'),
  ttft_ms: integer('ttft_ms'),
  cache_hit_rate: real('cache_hit_rate'),
  cache_read_tokens: integer('cache_read_tokens'),
  cache_write_tokens: integer('cache_write_tokens'),
  cost_usd: real('cost_usd'),
  success: integer('success').notNull(),
  measured_at: text('measured_at').notNull(),
}, (table) => [
  uniqueIndex('uq_runtime_model_run').on(table.model_id, table.run_id),
  index('idx_runtime_model_date').on(table.model_id, table.measured_at),
]);

export const catalog_cache_state = sqliteTable('catalog_cache_state', {
  source: text('source').primaryKey(),
  last_fetch: text('last_fetch').notNull(),
  last_status: text('last_status'),
  last_error: text('last_error'),
  count: integer('count'),
  next_refresh: text('next_refresh').notNull(),
});

// ── Legacy type exports (kept for existing consumers of these interfaces) ──

export interface ProviderRow {
  id: string;
  name: string;
  api_base: string | null;
  auth_scheme: 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';
  env_var: string | null;
  is_builtin: number;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
  header_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelRow {
  id: string;
  name: string;
  family: string | null;
  provider_id: string;
  release_date: string | null;
  attachment: number;
  reasoning: number;
  temperature: number;
  tool_call: number;
  interleaved: string | null;
  status: string | null;
  context_limit: number | null;
  input_limit: number | null;
  output_limit: number | null;
  modalities: string | null;
  reasoning_options: string | null;
  source_json: string;
  last_synced_at: string;
}

export interface ModelProviderRow {
  model_id: string;
  provider_id: string;
  api_model_id: string;
}

export interface PricingRow {
  model_id: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tier_size: number | null;
  over_200k_input: number | null;
  over_200k_output: number | null;
  over_200k_cache_read: number | null;
  over_200k_cache_write: number | null;
  updated_at: string;
}

export interface BenchmarkRow {
  id: number;
  model_id: string;
  benchmark: string;
  source: string;
  score: number;
  measured_at: string;
  source_url: string | null;
  is_preferred: number;
}

export interface ModelRuntimeStatRow {
  id: number;
  model_id: string;
  run_id: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tps: number | null;
  ttft_ms: number | null;
  cache_hit_rate: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  success: number;
  measured_at: string;
}

export interface CatalogCacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}
