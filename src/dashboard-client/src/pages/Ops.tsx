import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { useCacheStats, useRefreshCache } from '../hooks/useCache';
import { useLive } from '../hooks/useLive';

export function Ops() {
  const { data: cacheStats, isLoading } = useCacheStats();
  const refresh = useRefreshCache();
  const { processes } = useLive();

  return (
    <div className="flex flex-col gap-16">
      <h1 className="font-display text-28 font-600">Ops Console</h1>

      <Panel>
        <PanelHeader title="PM2 Processes" />
        <PanelBody>
          {(processes?.length ?? 0) === 0 ? (
            <EmptyState title="No active workers" />
          ) : (
            <table className="w-full font-mono text-14">
              <thead><tr className="text-fg-1 text-12 uppercase border-b border-border">
                <th className="px-8 py-8 text-left">Name</th><th className="px-8 py-8 text-left">Status</th>
                <th className="px-8 py-8 text-right">CPU</th><th className="px-8 py-8 text-right">Mem</th>
                <th className="px-8 py-8 text-left">Run</th>
              </tr></thead>
              <tbody>
                {(processes ?? []).map(p => (
                  <tr key={p.name} className="border-b border-border/50 hover:bg-bg-2">
                    <td className="px-8 py-8">{p.name}</td>
                    <td className="px-8 py-8"><Badge variant="status" value={p.status} /></td>
                    <td className="px-8 py-8 text-right" data-numeric>{p.cpu?.toFixed(1)}%</td>
                    <td className="px-8 py-8 text-right" data-numeric>{p.memory?.toFixed(0)}MB</td>
                    <td className="px-8 py-8 text-fg-1">{p.runId ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-3 gap-16">
        {(cacheStats ?? []).map(s => (
          <Panel key={s.source}>
            <PanelHeader title={s.source} actions={
              <Button variant="ghost" size="sm" onClick={() => refresh.mutate(s.source)} disabled={refresh.isPending}>
                Refresh
              </Button>
            } />
            <PanelBody>
              {isLoading ? <Spinner /> : (
                <div className="font-mono text-14 flex flex-col gap-4">
                  <div>Status: <span className={s.last_status === 'ok' ? 'text-accent' : 'text-danger'}>{s.last_status}</span></div>
                  <div>Count: <span data-numeric>{s.count ?? 0}</span></div>
                  <div>Last fetch: <span className="text-fg-1">{new Date(s.last_fetch).toLocaleString()}</span></div>
                  <div>Next refresh: <span className="text-fg-1">{new Date(s.next_refresh).toLocaleString()}</span></div>
                  {s.last_error && <div className="text-danger text-12 mt-8">{s.last_error}</div>}
                </div>
              )}
            </PanelBody>
          </Panel>
        ))}
        {!cacheStats && !isLoading && <Panel><EmptyState title="No cache data" /></Panel>}
      </div>
    </div>
  );
}
