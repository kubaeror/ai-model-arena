import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface RunnerInfo {
  name: string;
  provider: string;
  replicas: number;
  desiredReplicas: number;
  status: string;
  pods: Array<{
    name: string;
    status: string;
    node: string;
    startedAt: string;
  }>;
}

export function useRunners() {
  return useQuery({
    queryKey: ['runners'],
    queryFn: async () => {
      const res = await api.get('/api/runners');
      if (!res.ok) throw new Error('Failed to fetch runners');
      const data = await res.json();
      return data.runners as RunnerInfo[];
    },
    refetchInterval: 10000,
  });
}

export function useScaleRunner() {
  return {
    mutateAsync: async ({ name, replicas }: { name: string; replicas: number }) => {
      const res = await api.post(`/api/runners/${name}/scale`, {
        body: JSON.stringify({ replicas }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to scale');
      return res.json();
    },
  };
}

export function useDrainRunner() {
  return {
    mutateAsync: async (name: string) => {
      const res = await api.post(`/api/runners/${name}/drain`);
      if (!res.ok) throw new Error('Failed to drain');
      return res.json();
    },
  };
}
