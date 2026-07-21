import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

async function apiFetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

export interface CatalogModel {
  id: string;
  name: string;
  family: string | null;
  provider_id: string;
  release_date: string | null;
  attachment: number;
  reasoning: number;
  temperature: number;
  tool_call: number;
  context_limit: number | null;
  output_limit: number | null;
  status: string | null;
  reasoning_options: string | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

export interface CatalogModelFilters {
  provider?: string;
  reasoning?: '1' | '0';
  tool_call?: '1' | '0';
  min_context?: number;
  sort?: 'name' | 'context';
  q?: string;
}

export function useCatalogModels(filters: CatalogModelFilters = {}) {
  return useQuery({
    queryKey: ['catalog', 'models', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.provider) params.set('provider', filters.provider);
      if (filters.reasoning) params.set('reasoning', filters.reasoning);
      if (filters.tool_call) params.set('tool_call', filters.tool_call);
      if (filters.min_context) params.set('min_context', String(filters.min_context));
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.q) params.set('q', filters.q);
      const res = await apiFetchJson<{ data: CatalogModel[] }>(`/api/models?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 60_000,
  });
}

export interface ModelDetail extends CatalogModel {
  modalities: string | null;
  input_limit: number | null;
  tier_size: number | null;
  over_200k_input: number | null;
  over_200k_output: number | null;
  over_200k_cache_read: number | null;
  over_200k_cache_write: number | null;
}

export interface BenchmarkRow {
  model_id: string;
  benchmark: string;
  source: string;
  score: number;
  measured_at: string;
  source_url: string | null;
  is_preferred: number;
}

export interface RuntimeStatRow {
  run_id: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tps: number | null;
  ttft_ms: number | null;
  cache_hit_rate: number | null;
  cost_usd: number | null;
  success: number;
  measured_at: string;
}

export interface ModelDetailResponse {
  model: ModelDetail;
  benchmarks: BenchmarkRow[];
  runtime: RuntimeStatRow[];
}

export function useCatalogModel(id: string) {
  return useQuery({
    queryKey: ['catalog', 'model', id],
    queryFn: async () => {
      const res = await apiFetchJson<ModelDetailResponse>(`/api/models/${encodeURIComponent(id)}`);
      return res;
    },
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

export interface BenchmarkFilters {
  name?: string;
  source?: string;
  model?: string;
}

export function useBenchmarks(filters: BenchmarkFilters = {}) {
  return useQuery({
    queryKey: ['catalog', 'benchmarks', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.name) params.set('name', filters.name);
      if (filters.source) params.set('source', filters.source);
      if (filters.model) params.set('model', filters.model);
      const res = await apiFetchJson<{ data: BenchmarkRow[] }>(`/api/benchmarks?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 300_000,
  });
}

export function usePricing(model?: string) {
  return useQuery({
    queryKey: ['catalog', 'pricing', model],
    queryFn: async () => {
      const url = model ? `/api/pricing?model=${encodeURIComponent(model)}` : '/api/pricing';
      const res = await apiFetchJson<{ data: Array<Record<string, unknown>> }>(url);
      return res.data;
    },
    refetchInterval: 300_000,
  });
}
