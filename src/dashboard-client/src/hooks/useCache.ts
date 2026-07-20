import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

async function apiFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api.get(path, init);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  const res = await api.post(path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return res.json();
}

export interface CacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}

export function useCacheStats() {
  return useQuery({
    queryKey: ['cache', 'stats'],
    queryFn: async () => {
      const res = await apiFetchJson<{ data: CacheStateRow[] }>('/api/cache/stats');
      return res.data;
    },
    refetchInterval: 30_000,
  });
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  provider_id: string;
  context_limit: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  intelligence: number | null;
  coding: number | null;
  arena_tps: number | null;
  arena_latency: number | null;
  arena_runs: number;
}

export function useCacheLeaderboard() {
  return useQuery({
    queryKey: ['cache', 'leaderboard'],
    queryFn: async () => {
      const res = await apiFetchJson<{ data: LeaderboardEntry[] }>('/api/cache/leaderboard');
      return res.data;
    },
    refetchInterval: 15_000,
  });
}

export function useRefreshCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (source: string) => {
      return apiPostJson<{ ok: boolean; count: number; error?: string }>('/api/cache/refresh', { source });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cache'] });
      qc.invalidateQueries({ queryKey: ['catalog'] });
      qc.invalidateQueries({ queryKey: ['metrics'] });
    },
  });
}
