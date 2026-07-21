import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
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
    <div className="flex flex-col gap-16">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-28 font-600">Prompts</h1>
        <Button variant="default" size="sm">New Prompt</Button>
      </div>
      <Panel>
        <PanelHeader title="Prompt Versions" />
        <PanelBody>
          {isLoading ? <Spinner /> :
           !data || data.length === 0 ? (
            <div className="text-center py-32">
              <p className="font-body text-14 text-fg-1">No prompts created yet. Prompts define the system prompt + task for agent runs.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {data.map((p) => (
                <div key={p.id} className="border border-border rounded-lg p-12 flex items-center justify-between">
                  <div>
                    <h3 className="font-mono text-16 font-600">{p.name}</h3>
                    {p.description && <p className="text-fg-1 text-12">{p.description}</p>}
                  </div>
                  <span className="font-mono text-12 text-fg-1">{new Date(p.updatedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
