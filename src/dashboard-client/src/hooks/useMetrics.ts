import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { RuntimeStatRow } from './useCatalog';

async function apiFetchJson<T>(path: string): Promise<T> {
  const res = await api.get(path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

export interface RuntimeMetricFilters {
  model?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function useRuntimeMetrics(filters: RuntimeMetricFilters = {}) {
  return useQuery({
    queryKey: ['metrics', 'runtime', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.model) params.set('model', filters.model);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.limit) params.set('limit', String(filters.limit));
      const res = await apiFetchJson<{ data: RuntimeStatRow[] }>(`/api/metrics/runtime?${params.toString()}`);
      return res.data;
    },
    refetchInterval: 10_000,
  });
}

export interface TpsLeaderboardEntry {
  model_id: string;
  name: string;
  provider_id: string;
  avg_tps: number | null;
  max_tps: number | null;
  avg_latency_p50: number | null;
  avg_cache_hit_rate: number | null;
  run_count: number;
}

export function useTpsLeaderboard() {
  return useQuery({
    queryKey: ['metrics', 'tps'],
    queryFn: async () => {
      const res = await apiFetchJson<{ data: TpsLeaderboardEntry[] }>('/api/metrics/tps');
      return res.data;
    },
    refetchInterval: 10_000,
  });
}
