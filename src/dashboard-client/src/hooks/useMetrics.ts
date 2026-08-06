import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type { RuntimeStatRow } from './useCatalog';

interface RuntimeMetricFilters {
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
      const res = await apiFetch<{ data: RuntimeStatRow[] }>(`/api/metrics/runtime?${params.toString()}`);
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
      const res = await apiFetch<{ data: TpsLeaderboardEntry[] }>('/api/metrics/tps');
      return res.data;
    },
    refetchInterval: 10_000,
  });
}
