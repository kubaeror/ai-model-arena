import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';

// ── Drizzle table definitions (source of truth for migrations) ────────────

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

export const provider_versions = sqliteTable('provider_versions', {
  id: text('id').primaryKey(),
  provider_id: text('provider_id').notNull().references(() => providers.id),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  api_base: text('api_base'),
  auth_scheme: text('auth_scheme').notNull(),
  env_var: text('env_var'),
  adapter: text('adapter').notNull(),
  header_name: text('header_name'),
  created_by: text('created_by').notNull(),
  created_at: text('created_at').notNull(),
}, (table) => [
  index('idx_provider_versions_provider').on(table.provider_id),
]);

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
  tier_size: integer('tier_size').notNull().default(0),
  over_200k_input: real('over_200k_input'),
  over_200k_output: real('over_200k_output'),
  over_200k_cache_read: real('over_200k_cache_read'),
  over_200k_cache_write: real('over_200k_cache_write'),
  updated_at: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.model_id, table.tier_size] }),
]);

export const pricing_snapshots = sqliteTable('pricing_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull(),
  model_id: text('model_id').notNull(),
  input: real('input'),
  output: real('output'),
  cache_read: real('cache_read'),
  cache_write: real('cache_write'),
  tier_size: integer('tier_size'),
  over_200k_input: real('over_200k_input'),
  over_200k_output: real('over_200k_output'),
  over_200k_cache_read: real('over_200k_cache_read'),
  over_200k_cache_write: real('over_200k_cache_write'),
  snapshot_at: text('snapshot_at').notNull(),
});

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

export const anomalies = sqliteTable('anomalies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull(),
  model: text('model').notNull(),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  description: text('description').notNull(),
  detected_at: text('detected_at').notNull(),
  resolved: integer('resolved').notNull().default(0),
  resolved_at: text('resolved_at'),
  resolved_as: text('resolved_as'),
  metadata_json: text('metadata_json'),
}, (table) => [
  index('idx_anomalies_run').on(table.run_id),
  index('idx_anomalies_model').on(table.model),
  index('idx_anomalies_type').on(table.type),
  index('idx_anomalies_resolved').on(table.resolved),
  index('idx_anomalies_detected').on(table.detected_at),
  uniqueIndex('uq_anomalies_run_model_type').on(table.run_id, table.model, table.type),
]);

export const webhooks = sqliteTable('webhooks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  events: text('events').notNull(),
  secret: text('secret'),
  created_at: text('created_at').notNull(),
  active: integer('active').notNull().default(1),
});

export const runs = sqliteTable('runs', {
  run_id: text('run_id').primaryKey(),
  scenario: text('scenario').notNull(),
  models: text('models').notNull(),
  started_at: text('started_at').notNull(),
  finished_at: text('finished_at'),
  status: text('status').notNull(),
  source: text('source').notNull(),
  comparison_md_path: text('comparison_md_path'),
  comparison_json_path: text('comparison_json_path'),
  created_by: text('created_by'),
});

export const cost_ledger = sqliteTable('cost_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull().references(() => runs.run_id),
  model: text('model').notNull(),
  cost_usd: real('cost_usd').notNull(),
  currency: text('currency').notNull().default('USD'),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  cache_read_tokens: integer('cache_read_tokens'),
  total_tokens: integer('total_tokens'),
  pricing_version: text('pricing_version'),
  recorded_at: text('recorded_at').notNull(),
});

export const run_models = sqliteTable('run_models', {
  run_id: text('run_id').notNull().references(() => runs.run_id),
  model: text('model').notNull(),
  output_dir: text('output_dir'),
  sandbox_dir: text('sandbox_dir'),
  result_path: text('result_path'),
  conversation_path: text('conversation_path'),
  report_path: text('report_path'),
  log_file: text('log_file'),
  status: text('status').notNull(),
  claimed_at: text('claimed_at'),
  started_at: text('started_at'),
  completed_at: text('completed_at'),
  runner_id: text('runner_id'),
  success: integer('success'),
  turns_used: integer('turns_used'),
  total_tool_calls: integer('total_tool_calls'),
  stop_reason: text('stop_reason'),
  duration_ms: integer('duration_ms'),
});

export const tool_call_stats = sqliteTable('tool_call_stats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull().references(() => runs.run_id),
  model: text('model').notNull(),
  tool_name: text('tool_name').notNull(),
  total: integer('total').notNull().default(0),
  success_count: integer('success_count').notNull().default(0),
  fail_count: integer('fail_count').notNull().default(0),
  recorded_at: text('recorded_at').notNull(),
}, (table) => [
  index('idx_tool_stats_run').on(table.run_id),
  index('idx_tool_stats_model_tool').on(table.model, table.tool_name),
  index('idx_tool_stats_recorded').on(table.recorded_at),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  prompt_id: text('prompt_id'),
  prompt_version: integer('prompt_version'),
  model: text('model'),
  status: text('status').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  session_id: text('session_id').notNull().references(() => sessions.id),
  turn: integer('turn').notNull(),
  role: text('role').notNull(),
  content: text('content'),
  tool_calls: text('tool_calls'),
  tool_call_id: text('tool_call_id'),
  token_input: integer('token_input'),
  token_output: integer('token_output'),
  created_at: text('created_at').notNull(),
});

export const model_calls = sqliteTable('model_calls', {
  id: text('id').primaryKey(),
  session_id: text('session_id').notNull().references(() => sessions.id),
  turn: integer('turn').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  request_hash: text('request_hash').notNull(),
  response_text: text('response_text'),
  usage: text('usage'),
  latency_ms: integer('latency_ms'),
  ttft_ms: integer('ttft_ms'),
  created_at: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('uq_model_calls_session_turn').on(table.session_id, table.turn),
]);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: text('created_at').notNull(),
});

export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  description: text('description'),
});

export const user_roles = sqliteTable('user_roles', {
  user_id: text('user_id').notNull().references(() => users.id),
  role_id: text('role_id').notNull().references(() => roles.id),
});

export const audit_log = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id'),
  before: text('before'),
  after: text('after'),
  at: text('at').notNull(),
});

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull(),
  path: text('path').notNull(),
  prompt_id: text('prompt_id'),
  prompt_version: integer('prompt_version'),
  model: text('model').notNull(),
  config_hash: text('config_hash'),
  task_id: text('task_id'),
  trace_id: text('trace_id'),
  produced_at: text('produced_at').notNull(),
  produced_by_tool: text('produced_by_tool'),
});

export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const prompt_versions = sqliteTable('prompt_versions', {
  id: text('id').primaryKey(),
  prompt_id: text('prompt_id').notNull().references(() => prompts.id),
  version: integer('version').notNull(),
  system_prompt: text('system_prompt').notNull(),
  task: text('task').notNull(),
  config: text('config'),
  tag: text('tag'),
  created_at: text('created_at').notNull(),
  created_by: text('created_by').notNull(),
});

export const output_mappings = sqliteTable('output_mappings', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  scope_id: text('scope_id').notNull(),
  parent_folder: text('parent_folder').notNull(),
  per_model_pattern: text('per_model_pattern').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  scenario: text('scenario').notNull(),
  models: text('models').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled').notNull().default(1),
  last_run: text('last_run'),
  next_run: text('next_run'),
  last_status: text('last_status'),
  last_error: text('last_error'),
  consecutive_failures: integer('consecutive_failures').notNull().default(0),
  total_runs: integer('total_runs').notNull().default(0),
  total_failures: integer('total_failures').notNull().default(0),
  created_at: text('created_at').notNull(),
});

export const judge_scores = sqliteTable('judge_scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: text('run_id').notNull(),
  model: text('model').notNull(),
  judge_model: text('judge_model').notNull(),
  average_score: real('average_score').notNull(),
  summary: text('summary').notNull(),
  scores_json: text('scores_json').notNull(),
  judged_at: text('judged_at').notNull(),
}, (table) => [
  uniqueIndex('uq_judge_scores_run_model').on(table.run_id, table.model),
]);

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  event_type: text('event_type').notNull(),
  channel: text('channel').notNull(),
  payload_json: text('payload_json').notNull(),
  status: text('status').notNull().default('pending'), // pending | delivered | failed
  attempts: integer('attempts').notNull().default(0),
  last_error: text('last_error'),
  created_at: text('created_at').notNull(),
  next_attempt_at: text('next_attempt_at'),
  delivered_at: text('delivered_at'),
}, (table) => [
  index('idx_notifications_due').on(table.status, table.next_attempt_at),
  index('idx_notifications_created').on(table.created_at),
]);

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

export interface CatalogCacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}

// ── Drizzle-inferred types (preferred for new code) ─────────────────────
// Auto-derived from the table definitions above. Use these instead of the
// legacy hand-written interfaces when writing new Drizzle ORM code.
// Prefixed with `Db` to avoid conflicts with domain types.

import type { InferSelectModel } from 'drizzle-orm';

export type DbModel = InferSelectModel<typeof models>;
export type DbSession = InferSelectModel<typeof sessions>;
export type DbMessage = InferSelectModel<typeof messages>;
export type DbModelCall = InferSelectModel<typeof model_calls>;
export type DbUser = InferSelectModel<typeof users>;
export type DbRole = InferSelectModel<typeof roles>;
export type DbPrompt = InferSelectModel<typeof prompts>;
export type DbPromptVersion = InferSelectModel<typeof prompt_versions>;
export type DbOutputMapping = InferSelectModel<typeof output_mappings>;
export type DbSchedule = InferSelectModel<typeof schedules>;
export type DbJudgeScore = InferSelectModel<typeof judge_scores>;
export type DbNotification = InferSelectModel<typeof notifications>;
