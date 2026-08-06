// ── SQLite (dev) table definitions ─────────────────────────────────────────
// Built from the dialect-neutral spec in ./schema-defs.ts. This file is kept
// as the thin public surface used by queries and drizzle-kit (drizzle.config.ts).

import { buildSqliteTables } from './schema-builder.js';
import { tables } from './schema-defs.js';

export const {
  _migrations,
  providers,
  provider_versions,
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
} = buildSqliteTables(tables);

// ── Legacy type exports (kept for existing consumers of these interfaces) ──
export type {
  ProviderRow, ModelRow, ModelProviderRow, PricingRow, BenchmarkRow,
  ModelRuntimeStatRow, CatalogCacheStateRow,
} from './schema-types.js';

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
