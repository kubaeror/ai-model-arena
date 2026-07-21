import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { api } from '../lib/api';

interface QueueInfo {
  provider: string;
  depth: number;
  dlqDepth: number;
  consumerLag: number;
  maxReplicas: number;
}

export function Queues() {
  const { data, isLoading } = useQuery({
    queryKey: ['queues'],
    queryFn: async () => {
      const res = await api.get('/api/queues');
      if (!res.ok) throw new Error('Failed');
      return (await res.json()).queues as QueueInfo[];
    },
    refetchInterval: 5000,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Queues</h1>
      <Panel>
        <PanelHeader title="Task Queues" />
        <PanelBody>
          {isLoading ? <Spinner /> :
           !data || data.length === 0 ? <EmptyState title="No queues" /> : (
            <table className="w-full font-mono text-14">
              <thead><tr className="text-fg-1 text-12 uppercase border-b border-border">
                <th className="px-2 py-2 text-left">Provider</th>
                <th className="px-2 py-2 text-right">Depth</th>
                <th className="px-2 py-2 text-right">DLQ</th>
                <th className="px-2 py-2 text-right">Consumer Lag</th>
                <th className="px-2 py-2 text-right">Max Replicas</th>
              </tr></thead>
              <tbody>
                {data.map((q) => (
                  <tr key={q.provider} className="border-b border-border/50 hover:bg-bg-2">
                    <td className="px-2 py-2">{q.provider}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.depth}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.dlqDepth}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.consumerLag}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.maxReplicas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
