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
