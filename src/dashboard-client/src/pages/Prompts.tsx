import { useQuery } from '@tanstack/react-query';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { EmptyState } from '../components/ui/EmptyState';
import { api } from '../lib/api';

interface Prompt {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export function Prompts() {
  const { data, isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: async () => {
      const res = await api.get('/api/prompts');
      if (!res.ok) throw new Error('Failed');
      return (await res.json()).prompts as Prompt[];
    },
  });

  return (
    <PageShell
      title="Prompts"
      description="System prompts and task templates for agent runs"
      loading={isLoading}
    >
      <Panel>
        <PanelHeader title="Prompt Versions" />
        <PanelBody>
          {!data || data.length === 0 ? (
            <div className="text-center py-8">
              <EmptyState title="No prompts yet" description="Prompts define the system prompt and task for agent runs." />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {data.map((p) => (
                <div key={p.id} className="border border-border rounded-panel p-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-display text-16 font-600">{p.name}</h3>
                    {p.description && <p className="text-fg-1 text-12">{p.description}</p>}
                  </div>
                  <span className="font-mono text-12 text-fg-1">{new Date(p.updatedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
