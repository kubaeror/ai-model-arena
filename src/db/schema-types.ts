// ── Shared legacy row interfaces (dialect-neutral) ─────────────────────────
// Hand-written row interfaces historically duplicated verbatim in schema.ts
// (SQLite) and schema-pg.ts (Postgres). Kept here for existing consumers.
// The Drizzle-inferred `Db*` aliases are NOT shared: they derive from
// dialect-specific table objects (`InferSelectModel<typeof providers>`), so
// each dialect file defines its own against its own tables.

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

export interface CatalogCacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}
