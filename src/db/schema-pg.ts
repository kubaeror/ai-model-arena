// ── Postgres (production) table definitions ────────────────────────────────
// Built from the dialect-neutral spec in ./schema-defs.ts. This file is the
// public surface used by the Postgres client and drizzle-kit
// (drizzle.pg.config.ts).

import { buildPgTables } from './schema-builder.js';
import { tables } from './schema-defs.js';

export const {
  _migrations,
  providers,
  models,
  model_providers,
  pricing,
  pricing_snapshots,
  benchmarks,
  model_runtime_stats,
  catalog_cache_state,
  anomalies,
  webhooks,
  runs,
  cost_ledger,
  run_models,
  provider_versions,
  tool_call_stats,
  sessions,
  messages,
  model_calls,
  users,
  roles,
  user_roles,
  audit_log,
  files,
  prompts,
  prompt_versions,
  output_mappings,
  schedules,
  notifications,
  judge_scores,
} = buildPgTables(tables);

// ── Legacy type exports (kept for existing consumers) ──

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
  tier_size: number;
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

// ── Drizzle-inferred types (preferred for new code) ─────────────────────
// Auto-derived from the table definitions above. Use these instead of the
// legacy hand-written interfaces when writing new Drizzle ORM code.
// Prefixed with `Db` to avoid conflicts with domain types.

import type { InferSelectModel } from 'drizzle-orm';

export type DbProvider = InferSelectModel<typeof providers>;
export type DbProviderVersion = InferSelectModel<typeof provider_versions>;
export type DbModel = InferSelectModel<typeof models>;
export type DbModelProvider = InferSelectModel<typeof model_providers>;
export type DbPricing = InferSelectModel<typeof pricing>;
export type DbPricingSnapshot = InferSelectModel<typeof pricing_snapshots>;
export type DbBenchmark = InferSelectModel<typeof benchmarks>;
export type DbModelRuntimeStat = InferSelectModel<typeof model_runtime_stats>;
export type DbCatalogCacheState = InferSelectModel<typeof catalog_cache_state>;
export type DbAnomaly = InferSelectModel<typeof anomalies>;
export type DbWebhook = InferSelectModel<typeof webhooks>;
export type DbRun = InferSelectModel<typeof runs>;
export type DbCostLedgerEntry = InferSelectModel<typeof cost_ledger>;
export type DbRunModel = InferSelectModel<typeof run_models>;
export type DbSession = InferSelectModel<typeof sessions>;
export type DbMessage = InferSelectModel<typeof messages>;
export type DbModelCall = InferSelectModel<typeof model_calls>;
export type DbUser = InferSelectModel<typeof users>;
export type DbRole = InferSelectModel<typeof roles>;
export type DbUserRole = InferSelectModel<typeof user_roles>;
export type DbAuditLogEntry = InferSelectModel<typeof audit_log>;
export type DbFile = InferSelectModel<typeof files>;
export type DbPrompt = InferSelectModel<typeof prompts>;
export type DbPromptVersion = InferSelectModel<typeof prompt_versions>;
export type DbOutputMapping = InferSelectModel<typeof output_mappings>;
export type DbSchedule = InferSelectModel<typeof schedules>;
export type DbToolCallStat = InferSelectModel<typeof tool_call_stats>;
export type DbJudgeScore = InferSelectModel<typeof judge_scores>;
