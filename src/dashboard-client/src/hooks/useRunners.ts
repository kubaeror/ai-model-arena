import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface RunnerInfo {
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

async function runnerError(res: Response, fallback: string): Promise<Error> {
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const body = await res.json();
    if (body?.error) message = body.error;
  } catch {
    /* keep the fallback message */
  }
  return new Error(message);
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, replicas }: { name: string; replicas: number }) => {
      const res = await api.post(`/api/runners/${encodeURIComponent(name)}/scale`, {
        body: JSON.stringify({ replicas }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw await runnerError(res, 'Failed to scale runner');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
  });
}

export function useDrainRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await api.post(`/api/runners/${encodeURIComponent(name)}/drain`);
      if (!res.ok) throw await runnerError(res, 'Failed to drain runner');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runners'] }),
  });
}
