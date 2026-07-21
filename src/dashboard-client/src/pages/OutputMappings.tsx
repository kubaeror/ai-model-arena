import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { api } from '../lib/api';

interface OutputMapping {
  id: string;
  scope: string;
  scopeId: string;
  parentFolder: string;
  perModelPattern: string;
  createdAt: string;
}

export function OutputMappings() {
  const { data, isLoading } = useQuery({
    queryKey: ['output-mappings'],
    queryFn: async () => {
      const res = await api.get('/api/output-mappings');
      if (!res.ok) throw new Error('Failed');
      return (await res.json()).mappings as OutputMapping[];
    },
  });

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Output Mappings</h1>
      <Panel>
        <PanelHeader title="Global Output Location Mapping" />
        <PanelBody>
          {isLoading ? <Spinner /> :
           !data || data.length === 0 ? <EmptyState title="No mappings configured" description="Defaults to OUTPUT_ROOT/<model>/<runId>" /> : (
            <table className="w-full font-mono text-14">
              <thead><tr className="text-fg-1 text-12 uppercase border-b border-border">
                <th className="px-8 py-8 text-left">Scope</th>
                <th className="px-8 py-8 text-left">Scope ID</th>
                <th className="px-8 py-8 text-left">Parent Folder</th>
                <th className="px-8 py-8 text-left">Pattern</th>
              </tr></thead>
              <tbody>
                {data.map((m) => (
                  <tr key={m.id} className="border-b border-border/50 hover:bg-bg-2">
                    <td className="px-8 py-8">{m.scope}</td>
                    <td className="px-8 py-8">{m.scopeId}</td>
                    <td className="px-8 py-8">{m.parentFolder}</td>
                    <td className="px-8 py-8 font-mono text-12">{m.perModelPattern}</td>
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
