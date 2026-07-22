import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { api } from '../lib/api';

interface QueueInfo {
  provider: string;
  depth: number;
  dlqDepth: number;
  consumerLag: number;
  maxReplicas: number;
}

interface DlqTask {
  id: string;
  taskId?: string;
  model?: string;
  scenario?: string;
  error?: string;
  [key: string]: unknown;
}

export function Queues() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['queues'],
    queryFn: async () => {
      const res = await api.get('/api/queues');
      if (!res.ok) throw new Error('Failed');
      return (await res.json()).queues as QueueInfo[];
    },
    refetchInterval: 5000,
  });

  const [viewProvider, setViewProvider] = useState<string | null>(null);
  const [dlqTasks, setDlqTasks] = useState<DlqTask[]>([]);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [retryIds, setRetryIds] = useState<Set<string>>(new Set());

  async function viewTasks(provider: string) {
    setViewProvider(provider);
    setDlqLoading(true);
    try {
      const res = await api.get(`/api/queues/${encodeURIComponent(provider)}/tasks?limit=50`);
      const data = await res.json();
      setDlqTasks(data.tasks ?? []);
    } catch {
      setDlqTasks([]);
    } finally {
      setDlqLoading(false);
    }
  }

  async function retryTask(provider: string, taskId: string) {
    setRetryIds(prev => new Set(prev).add(taskId));
    try {
      await api.post(`/api/queues/${encodeURIComponent(provider)}/tasks/${encodeURIComponent(taskId)}/retry`);
      qc.invalidateQueries({ queryKey: ['queues'] });
    } catch {
      /* errors shown inline */
    } finally {
      setRetryIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

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
                <th className="px-2 py-2 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {data.map((q) => (
                  <tr key={q.provider} className="border-b border-border/50 hover:bg-bg-2">
                    <td className="px-2 py-2">{q.provider}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.depth}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.dlqDepth}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.consumerLag ?? '-'}</td>
                    <td className="px-2 py-2 text-right" data-numeric>{q.maxReplicas ?? '-'}</td>
                    <td className="px-2 py-2 text-right">
                      <Button variant="ghost" size="sm" onClick={() => viewTasks(q.provider)}>View DLQ</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Modal open={!!viewProvider} onClose={() => setViewProvider(null)} title={`DLQ Tasks: ${viewProvider ?? ''}`}>
        <div className="h-[50vh] overflow-auto nice-scroll">
          {dlqLoading ? <div className="p-3"><Spinner /></div> : dlqTasks.length === 0 ? (
            <EmptyState title="No dead-lettered tasks" />
          ) : (
            <table className="w-full font-mono text-12">
              <thead><tr className="text-fg-1 uppercase border-b border-border">
                <th className="px-2 py-1 text-left">Task ID</th>
                <th className="px-2 py-1 text-left">Model</th>
                <th className="px-2 py-1 text-left">Scenario</th>
                <th className="px-2 py-1 text-left">Error</th>
                <th className="px-2 py-1 text-left">Action</th>
              </tr></thead>
              <tbody>
                {dlqTasks.map(t => (
                  <tr key={t.id ?? t.taskId} className="border-b border-border/50">
                    <td className="px-2 py-1">{t.id ?? t.taskId ?? '-'}</td>
                    <td className="px-2 py-1">{t.model ?? '-'}</td>
                    <td className="px-2 py-1">{t.scenario ?? '-'}</td>
                    <td className="px-2 py-1 max-w-[200px] truncate text-red-500">{t.error ?? '-'}</td>
                    <td className="px-2 py-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => retryTask(viewProvider!, t.id ?? t.taskId ?? '')}
                        disabled={retryIds.has(t.id ?? t.taskId ?? '')}
                      >
                        {retryIds.has(t.id ?? t.taskId ?? '') ? '...' : 'Retry'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </div>
  );
}
