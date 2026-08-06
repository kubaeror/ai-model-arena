// ── Dialect-neutral table definitions (single source of truth) ─────────────
// Ported one-for-one from the former src/db/schema.ts table definitions.
// Both src/db/schema.ts (SQLite) and src/db/schema-pg.ts (Postgres) build
// their tables from this spec via src/db/schema-builder.ts.
//
// Constraint encoding:
//   primaryKey       — column-level primary key (text -> `text('id').primaryKey()`,
//                       int   -> `integer('id').primaryKey({ autoIncrement })` on
//                                SQLite, `serial('id').primaryKey()` on Postgres)
//   autoIncrement    — serial-style PK (9 tables in this schema)
//   notNull          — `.notNull()`
//   default          — literal `.default(<value>)`; booleans are stored as
//                      integer 1/0 literals (e.g. `enabled` default(1))
//   unique           — column-level `.unique()` (users.username, prompts.name)
//   references       — `.references(() => <table>.<column>)`, resolved lazily so
//                      table order in `tables` does not matter
//   indexes          — named `index(...)` / `uniqueIndex(...)` builders
//   compositePrimaryKey — table-level `primaryKey({ columns })` (model_providers,
//                      pricing)

export type ColumnDef = {
  type: 'text' | 'int' | 'real';
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  default?: string | number | boolean | null;
  unique?: boolean;
  references?: { table: string; column: string };
};

interface IndexDef {
  name: string;
  unique?: boolean;
  on: string[];
}

export interface TableDef {
  name: string;
  columns: Record<string, ColumnDef>;
  indexes?: IndexDef[];
  compositePrimaryKey?: string[];
}

const _migrationsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  applied_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const providersColumns = {
  id: { type: 'text' as const, primaryKey: true },
  name: { type: 'text' as const, notNull: true },
  api_base: { type: 'text' as const },
  auth_scheme: { type: 'text' as const, notNull: true },
  env_var: { type: 'text' as const },
  is_builtin: { type: 'int' as const, notNull: true, default: 0 },
  adapter: { type: 'text' as const, notNull: true },
  header_name: { type: 'text' as const },
  created_at: { type: 'text' as const, notNull: true },
  updated_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const providerVersionsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  provider_id: { type: 'text' as const, notNull: true, references: { table: 'providers', column: 'id' } },
  version: { type: 'int' as const, notNull: true },
  name: { type: 'text' as const, notNull: true },
  api_base: { type: 'text' as const },
  auth_scheme: { type: 'text' as const, notNull: true },
  env_var: { type: 'text' as const },
  adapter: { type: 'text' as const, notNull: true },
  header_name: { type: 'text' as const },
  created_by: { type: 'text' as const, notNull: true },
  created_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const modelsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  name: { type: 'text' as const, notNull: true },
  family: { type: 'text' as const },
  provider_id: { type: 'text' as const, notNull: true, references: { table: 'providers', column: 'id' } },
  release_date: { type: 'text' as const },
  attachment: { type: 'int' as const, notNull: true, default: 0 },
  reasoning: { type: 'int' as const, notNull: true, default: 0 },
  temperature: { type: 'int' as const, notNull: true, default: 0 },
  tool_call: { type: 'int' as const, notNull: true, default: 0 },
  interleaved: { type: 'text' as const },
  status: { type: 'text' as const },
  context_limit: { type: 'int' as const },
  input_limit: { type: 'int' as const },
  output_limit: { type: 'int' as const },
  modalities: { type: 'text' as const },
  reasoning_options: { type: 'text' as const },
  source_json: { type: 'text' as const },
  last_synced_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const modelProvidersColumns = {
  model_id: { type: 'text' as const, notNull: true, references: { table: 'models', column: 'id' } },
  provider_id: { type: 'text' as const, notNull: true, references: { table: 'providers', column: 'id' } },
  api_model_id: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const pricingColumns = {
  model_id: { type: 'text' as const, notNull: true, references: { table: 'models', column: 'id' } },
  input: { type: 'real' as const },
  output: { type: 'real' as const },
  cache_read: { type: 'real' as const },
  cache_write: { type: 'real' as const },
  tier_size: { type: 'int' as const, notNull: true, default: 0 },
  over_200k_input: { type: 'real' as const },
  over_200k_output: { type: 'real' as const },
  over_200k_cache_read: { type: 'real' as const },
  over_200k_cache_write: { type: 'real' as const },
  updated_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const pricingSnapshotsColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  version: { type: 'text' as const, notNull: true },
  model_id: { type: 'text' as const, notNull: true },
  input: { type: 'real' as const },
  output: { type: 'real' as const },
  cache_read: { type: 'real' as const },
  cache_write: { type: 'real' as const },
  tier_size: { type: 'int' as const },
  over_200k_input: { type: 'real' as const },
  over_200k_output: { type: 'real' as const },
  over_200k_cache_read: { type: 'real' as const },
  over_200k_cache_write: { type: 'real' as const },
  snapshot_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const benchmarksColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  model_id: { type: 'text' as const, notNull: true, references: { table: 'models', column: 'id' } },
  benchmark: { type: 'text' as const, notNull: true },
  source: { type: 'text' as const, notNull: true },
  score: { type: 'real' as const, notNull: true },
  measured_at: { type: 'text' as const, notNull: true },
  source_url: { type: 'text' as const },
  is_preferred: { type: 'int' as const, notNull: true, default: 0 },
} satisfies Record<string, ColumnDef>;

const modelRuntimeStatsColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  model_id: { type: 'text' as const, notNull: true, references: { table: 'models', column: 'id' } },
  run_id: { type: 'text' as const, notNull: true },
  latency_p50_ms: { type: 'int' as const },
  latency_p95_ms: { type: 'int' as const },
  tps: { type: 'real' as const },
  ttft_ms: { type: 'int' as const },
  cache_hit_rate: { type: 'real' as const },
  cache_read_tokens: { type: 'int' as const },
  cache_write_tokens: { type: 'int' as const },
  cost_usd: { type: 'real' as const },
  success: { type: 'int' as const, notNull: true },
  measured_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const catalogCacheStateColumns = {
  source: { type: 'text' as const, primaryKey: true },
  last_fetch: { type: 'text' as const, notNull: true },
  last_status: { type: 'text' as const },
  last_error: { type: 'text' as const },
  count: { type: 'int' as const },
  next_refresh: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const anomaliesColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  run_id: { type: 'text' as const, notNull: true },
  model: { type: 'text' as const, notNull: true },
  type: { type: 'text' as const, notNull: true },
  severity: { type: 'text' as const, notNull: true },
  description: { type: 'text' as const, notNull: true },
  detected_at: { type: 'text' as const, notNull: true },
  resolved: { type: 'int' as const, notNull: true, default: 0 },
  resolved_at: { type: 'text' as const },
  resolved_as: { type: 'text' as const },
  metadata_json: { type: 'text' as const },
} satisfies Record<string, ColumnDef>;

const webhooksColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  url: { type: 'text' as const, notNull: true },
  events: { type: 'text' as const, notNull: true },
  secret: { type: 'text' as const },
  created_at: { type: 'text' as const, notNull: true },
  active: { type: 'int' as const, notNull: true, default: 1 },
} satisfies Record<string, ColumnDef>;

const runsColumns = {
  run_id: { type: 'text' as const, primaryKey: true },
  scenario: { type: 'text' as const, notNull: true },
  models: { type: 'text' as const, notNull: true },
  started_at: { type: 'text' as const, notNull: true },
  finished_at: { type: 'text' as const },
  status: { type: 'text' as const, notNull: true },
  source: { type: 'text' as const, notNull: true },
  comparison_md_path: { type: 'text' as const },
  comparison_json_path: { type: 'text' as const },
  created_by: { type: 'text' as const },
} satisfies Record<string, ColumnDef>;

const costLedgerColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  run_id: { type: 'text' as const, notNull: true, references: { table: 'runs', column: 'run_id' } },
  model: { type: 'text' as const, notNull: true },
  cost_usd: { type: 'real' as const, notNull: true },
  currency: { type: 'text' as const, notNull: true, default: 'USD' },
  input_tokens: { type: 'int' as const },
  output_tokens: { type: 'int' as const },
  cache_read_tokens: { type: 'int' as const },
  total_tokens: { type: 'int' as const },
  pricing_version: { type: 'text' as const },
  recorded_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const runModelsColumns = {
  run_id: { type: 'text' as const, notNull: true, references: { table: 'runs', column: 'run_id' } },
  model: { type: 'text' as const, notNull: true },
  output_dir: { type: 'text' as const },
  sandbox_dir: { type: 'text' as const },
  result_path: { type: 'text' as const },
  conversation_path: { type: 'text' as const },
  report_path: { type: 'text' as const },
  log_file: { type: 'text' as const },
  status: { type: 'text' as const, notNull: true },
  claimed_at: { type: 'text' as const },
  started_at: { type: 'text' as const },
  completed_at: { type: 'text' as const },
  runner_id: { type: 'text' as const },
  success: { type: 'int' as const },
  turns_used: { type: 'int' as const },
  total_tool_calls: { type: 'int' as const },
  stop_reason: { type: 'text' as const },
  duration_ms: { type: 'int' as const },
} satisfies Record<string, ColumnDef>;

const toolCallStatsColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  run_id: { type: 'text' as const, notNull: true, references: { table: 'runs', column: 'run_id' } },
  model: { type: 'text' as const, notNull: true },
  tool_name: { type: 'text' as const, notNull: true },
  total: { type: 'int' as const, notNull: true, default: 0 },
  success_count: { type: 'int' as const, notNull: true, default: 0 },
  fail_count: { type: 'int' as const, notNull: true, default: 0 },
  recorded_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const sessionsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  prompt_id: { type: 'text' as const },
  prompt_version: { type: 'int' as const },
  model: { type: 'text' as const },
  status: { type: 'text' as const, notNull: true },
  created_at: { type: 'text' as const, notNull: true },
  updated_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const messagesColumns = {
  id: { type: 'text' as const, primaryKey: true },
  session_id: { type: 'text' as const, notNull: true, references: { table: 'sessions', column: 'id' } },
  turn: { type: 'int' as const, notNull: true },
  role: { type: 'text' as const, notNull: true },
  content: { type: 'text' as const },
  tool_calls: { type: 'text' as const },
  tool_call_id: { type: 'text' as const },
  token_input: { type: 'int' as const },
  token_output: { type: 'int' as const },
  created_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const modelCallsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  session_id: { type: 'text' as const, notNull: true, references: { table: 'sessions', column: 'id' } },
  turn: { type: 'int' as const, notNull: true },
  provider: { type: 'text' as const, notNull: true },
  model: { type: 'text' as const, notNull: true },
  request_hash: { type: 'text' as const, notNull: true },
  response_text: { type: 'text' as const },
  usage: { type: 'text' as const },
  latency_ms: { type: 'int' as const },
  ttft_ms: { type: 'int' as const },
  created_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const usersColumns = {
  id: { type: 'text' as const, primaryKey: true },
  username: { type: 'text' as const, notNull: true, unique: true },
  password_hash: { type: 'text' as const, notNull: true },
  created_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const rolesColumns = {
  id: { type: 'text' as const, primaryKey: true },
  description: { type: 'text' as const },
} satisfies Record<string, ColumnDef>;

const userRolesColumns = {
  user_id: { type: 'text' as const, notNull: true, references: { table: 'users', column: 'id' } },
  role_id: { type: 'text' as const, notNull: true, references: { table: 'roles', column: 'id' } },
} satisfies Record<string, ColumnDef>;

const auditLogColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  actor: { type: 'text' as const, notNull: true },
  action: { type: 'text' as const, notNull: true },
  entity_type: { type: 'text' as const, notNull: true },
  entity_id: { type: 'text' as const },
  before: { type: 'text' as const },
  after: { type: 'text' as const },
  at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const filesColumns = {
  id: { type: 'text' as const, primaryKey: true },
  run_id: { type: 'text' as const, notNull: true },
  path: { type: 'text' as const, notNull: true },
  prompt_id: { type: 'text' as const },
  prompt_version: { type: 'int' as const },
  model: { type: 'text' as const, notNull: true },
  config_hash: { type: 'text' as const },
  task_id: { type: 'text' as const },
  trace_id: { type: 'text' as const },
  produced_at: { type: 'text' as const, notNull: true },
  produced_by_tool: { type: 'text' as const },
} satisfies Record<string, ColumnDef>;

const promptsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  name: { type: 'text' as const, notNull: true, unique: true },
  description: { type: 'text' as const },
  created_at: { type: 'text' as const, notNull: true },
  updated_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const promptVersionsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  prompt_id: { type: 'text' as const, notNull: true, references: { table: 'prompts', column: 'id' } },
  version: { type: 'int' as const, notNull: true },
  system_prompt: { type: 'text' as const, notNull: true },
  task: { type: 'text' as const, notNull: true },
  config: { type: 'text' as const },
  tag: { type: 'text' as const },
  created_at: { type: 'text' as const, notNull: true },
  created_by: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const outputMappingsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  scope: { type: 'text' as const, notNull: true },
  scope_id: { type: 'text' as const, notNull: true },
  parent_folder: { type: 'text' as const, notNull: true },
  per_model_pattern: { type: 'text' as const, notNull: true },
  created_at: { type: 'text' as const, notNull: true },
  updated_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const schedulesColumns = {
  id: { type: 'text' as const, primaryKey: true },
  scenario: { type: 'text' as const, notNull: true },
  models: { type: 'text' as const, notNull: true },
  cron: { type: 'text' as const, notNull: true },
  enabled: { type: 'int' as const, notNull: true, default: 1 },
  last_run: { type: 'text' as const },
  next_run: { type: 'text' as const },
  last_status: { type: 'text' as const },
  last_error: { type: 'text' as const },
  consecutive_failures: { type: 'int' as const, notNull: true, default: 0 },
  total_runs: { type: 'int' as const, notNull: true, default: 0 },
  total_failures: { type: 'int' as const, notNull: true, default: 0 },
  created_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

const notificationsColumns = {
  id: { type: 'text' as const, primaryKey: true },
  event_type: { type: 'text' as const, notNull: true },
  channel: { type: 'text' as const, notNull: true },
  payload_json: { type: 'text' as const, notNull: true },
  status: { type: 'text' as const, notNull: true, default: 'pending' },
  attempts: { type: 'int' as const, notNull: true, default: 0 },
  last_error: { type: 'text' as const },
  created_at: { type: 'text' as const, notNull: true },
  next_attempt_at: { type: 'text' as const },
  delivered_at: { type: 'text' as const },
} satisfies Record<string, ColumnDef>;

const judgeScoresColumns = {
  id: { type: 'int' as const, primaryKey: true, autoIncrement: true },
  run_id: { type: 'text' as const, notNull: true },
  model: { type: 'text' as const, notNull: true },
  judge_model: { type: 'text' as const, notNull: true },
  average_score: { type: 'real' as const, notNull: true },
  summary: { type: 'text' as const, notNull: true },
  scores_json: { type: 'text' as const, notNull: true },
  judged_at: { type: 'text' as const, notNull: true },
} satisfies Record<string, ColumnDef>;

export const tables = [
  { name: '_migrations', columns: _migrationsColumns },
  { name: 'providers', columns: providersColumns },
  {
    name: 'provider_versions',
    columns: providerVersionsColumns,
    indexes: [{ name: 'idx_provider_versions_provider', on: ['provider_id'] }],
  },
  {
    name: 'models',
    columns: modelsColumns,
    indexes: [
      { name: 'uq_models_provider_name', unique: true, on: ['provider_id', 'name'] },
      { name: 'idx_models_provider', on: ['provider_id'] },
      { name: 'idx_models_reasoning', on: ['reasoning'] },
    ],
  },
  {
    name: 'model_providers',
    columns: modelProvidersColumns,
    compositePrimaryKey: ['model_id', 'provider_id'],
  },
  {
    name: 'pricing',
    columns: pricingColumns,
    compositePrimaryKey: ['model_id', 'tier_size'],
  },
  { name: 'pricing_snapshots', columns: pricingSnapshotsColumns },
  {
    name: 'benchmarks',
    columns: benchmarksColumns,
    indexes: [
      { name: 'uq_benchmarks_model_source', unique: true, on: ['model_id', 'benchmark', 'source'] },
      { name: 'idx_benchmarks_model', on: ['model_id', 'benchmark'] },
    ],
  },
  {
    name: 'model_runtime_stats',
    columns: modelRuntimeStatsColumns,
    indexes: [
      { name: 'uq_runtime_model_run', unique: true, on: ['model_id', 'run_id'] },
      { name: 'idx_runtime_model_date', on: ['model_id', 'measured_at'] },
    ],
  },
  { name: 'catalog_cache_state', columns: catalogCacheStateColumns },
  {
    name: 'anomalies',
    columns: anomaliesColumns,
    indexes: [
      { name: 'idx_anomalies_run', on: ['run_id'] },
      { name: 'idx_anomalies_model', on: ['model'] },
      { name: 'idx_anomalies_type', on: ['type'] },
      { name: 'idx_anomalies_resolved', on: ['resolved'] },
      { name: 'idx_anomalies_detected', on: ['detected_at'] },
      { name: 'uq_anomalies_run_model_type', unique: true, on: ['run_id', 'model', 'type'] },
    ],
  },
  { name: 'webhooks', columns: webhooksColumns },
  { name: 'runs', columns: runsColumns },
  { name: 'cost_ledger', columns: costLedgerColumns },
  { name: 'run_models', columns: runModelsColumns },
  {
    name: 'tool_call_stats',
    columns: toolCallStatsColumns,
    indexes: [
      { name: 'idx_tool_stats_run', on: ['run_id'] },
      { name: 'idx_tool_stats_model_tool', on: ['model', 'tool_name'] },
      { name: 'idx_tool_stats_recorded', on: ['recorded_at'] },
    ],
  },
  { name: 'sessions', columns: sessionsColumns },
  { name: 'messages', columns: messagesColumns },
  {
    name: 'model_calls',
    columns: modelCallsColumns,
    indexes: [{ name: 'uq_model_calls_session_turn', unique: true, on: ['session_id', 'turn'] }],
  },
  { name: 'users', columns: usersColumns },
  { name: 'roles', columns: rolesColumns },
  { name: 'user_roles', columns: userRolesColumns },
  { name: 'audit_log', columns: auditLogColumns },
  { name: 'files', columns: filesColumns },
  { name: 'prompts', columns: promptsColumns },
  { name: 'prompt_versions', columns: promptVersionsColumns },
  { name: 'output_mappings', columns: outputMappingsColumns },
  { name: 'schedules', columns: schedulesColumns },
  {
    name: 'notifications',
    columns: notificationsColumns,
    indexes: [
      { name: 'idx_notifications_due', on: ['status', 'next_attempt_at'] },
      { name: 'idx_notifications_created', on: ['created_at'] },
    ],
  },
  {
    name: 'judge_scores',
    columns: judgeScoresColumns,
    indexes: [{ name: 'uq_judge_scores_run_model', unique: true, on: ['run_id', 'model'] }],
  },
] as const satisfies readonly TableDef[];
