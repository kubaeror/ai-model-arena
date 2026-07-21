import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { useRunners, useScaleRunner, useDrainRunner } from '../hooks/useRunners';

export function Runners() {
  const { data: runners, isLoading } = useRunners();
  const scale = useScaleRunner();
  const drain = useDrainRunner();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-28 font-600">Runners</h1>

      <Panel>
        <PanelHeader title="Runner Deployments" />
        <PanelBody>
          {isLoading ? <Spinner /> :
           !runners || runners.length === 0 ? <EmptyState title="No runners deployed" /> : (
            <div className="flex flex-col gap-4">
              {runners.map((r) => (
                <div key={r.name} className="border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h3 className="font-mono text-16 font-600">{r.name}</h3>
                      <p className="text-fg-1 text-12">Provider: {r.provider}</p>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Badge variant="status" value={r.status} />
                      <span className="font-mono text-14">
                        {r.replicas}/{r.desiredReplicas} pods
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="number"
                      min={0}
                      max={10}
                      defaultValue={r.desiredReplicas}
                      className="h-2 w-4 rounded border border-border bg-bg-1 px-2 text-center font-mono text-12"
                      onBlur={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (v >= 0) scale.mutateAsync({ name: r.name, replicas: v });
                      }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => drain.mutateAsync(r.name)}>
                      Drain
                    </Button>
                  </div>
                  {r.pods.length > 0 && (
                    <table className="w-full font-mono text-12">
                      <thead><tr className="text-fg-1 uppercase border-b border-border">
                        <th className="px-1 py-1 text-left">Pod</th>
                        <th className="px-1 py-1 text-left">Status</th>
                        <th className="px-1 py-1 text-left">Node</th>
                      </tr></thead>
                      <tbody>
                        {r.pods.map((p) => (
                          <tr key={p.name} className="border-b border-border/50">
                            <td className="px-1 py-1">{p.name}</td>
                            <td className="px-1 py-1"><Badge variant="status" value={p.status} /></td>
                            <td className="px-1 py-1 text-fg-1">{p.node}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
