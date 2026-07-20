import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { StatTile } from '../components/ui/StatTile';
import { DataTable } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { getObservabilityStats, getRecentTraces } from '../lib/api';
import type { Column } from '../components/ui/DataTable';

export function Observability() {
  const stats = useQuery({
    queryKey: ['observability', 'stats'],
    queryFn: () => getObservabilityStats(),
    refetchInterval: 15_000,
  });

  const traces = useQuery({
    queryKey: ['observability', 'recent-traces'],
    queryFn: () => getRecentTraces(50),
    refetchInterval: 15_000,
  });

  const totalRuns = stats.data?.models.reduce((sum, m) => sum + m.runs, 0) ?? 0;
  const totalErrors = traces.data?.reduce((sum, t) => sum + t.errorCount, 0) ?? 0;
  const totalChatSpans = stats.data?.latency
    .filter(l => l.tool.startsWith('chat:'))
    .reduce((sum, l) => sum + l.count, 0) ?? 0;
  const totalModels = stats.data?.models.length ?? 0;

  const latencyColumns: Column<(typeof stats.data)['latency'][number]>[] = [
    { key: 'model', header: 'Model', sortable: true },
    { key: 'tool', header: 'Operation', sortable: true },
    { key: 'count', header: 'Count', sortable: true },
    { key: 'avgMs', header: 'Avg (ms)', sortable: true, render: r => r.avgMs.toFixed(1) },
    { key: 'p95Ms', header: 'P95 (ms)', sortable: true, render: r => r.p95Ms.toFixed(1) },
    { key: 'p99Ms', header: 'P99 (ms)', sortable: true, render: r => r.p99Ms.toFixed(1) },
  ];

  return (
    <div className="flex flex-col gap-24">
      <h1 className="font-display text-44 font-700">Observability</h1>

      <div className="grid grid-cols-4 gap-16">
        <StatTile
          value={stats.isLoading ? <Spinner /> : totalRuns}
          label="Total Runs"
        />
        <StatTile
          value={stats.isLoading ? <Spinner /> : totalErrors}
          label="Trace Errors"
        />
        <StatTile
          value={stats.isLoading ? <Spinner /> : totalChatSpans}
          label="Chat Spans"
        />
        <StatTile
          value={stats.isLoading ? <Spinner /> : totalModels}
          label="Models Tracked"
        />
      </div>

      <div className="grid grid-cols-2 gap-16">
        <Panel>
          <PanelHeader
            title="Model Stats"
            actions={
              <span className="font-mono text-12 text-fg-1">
                generated {stats.data ? new Date(stats.data.generatedAt).toLocaleTimeString() : '...'}
              </span>
            }
          />
          <PanelBody>
            {stats.isLoading ? <Spinner /> : (stats.data?.models.length ?? 0) === 0 ? (
              <EmptyState title="No model stats" description="Run benchmarks to collect data." />
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-8 py-8 text-left font-mono text-12 uppercase text-fg-1">Model</th>
                    <th className="px-8 py-8 text-right font-mono text-12 uppercase text-fg-1">Runs</th>
                    <th className="px-8 py-8 text-right font-mono text-12 uppercase text-fg-1">Error Rate</th>
                    <th className="px-8 py-8 text-right font-mono text-12 uppercase text-fg-1">Anomalies</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data?.models.map(m => (
                    <tr key={m.model} className="border-b border-border/50 hover:bg-bg-2">
                      <td className="px-8 py-8 font-mono text-14">{m.model}</td>
                      <td className="px-8 py-8 font-mono text-14 text-right" data-numeric>{m.runs}</td>
                      <td className="px-8 py-8 font-mono text-14 text-right" data-numeric>
                        <span className={m.errorRate > 0 ? 'text-danger' : 'text-accent'}>
                          {(m.errorRate * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-8 py-8 font-mono text-14 text-right" data-numeric>
                        {m.unresolvedAnomalies > 0 ? (
                          <span className="text-danger">{m.unresolvedAnomalies}</span>
                        ) : (
                          <span className="text-fg-1">{m.anomalies}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Recent Traces" />
          <PanelBody>
            {traces.isLoading ? <Spinner /> : (traces.data?.length ?? 0) === 0 ? (
              <EmptyState title="No traces" description="Run benchmarks to collect trace data." />
            ) : (
              <DataTable
                columns={[
                  { key: 'model', header: 'Model' },
                  { key: 'scenario', header: 'Scenario' },
                  { key: 'spanCount', header: 'Spans', render: (r) => <span data-numeric>{r.spanCount}</span>, className: 'text-right' },
                  { key: 'errorCount', header: 'Errors', render: (r) => <span data-numeric className={r.errorCount > 0 ? 'text-danger' : 'text-accent'}>{r.errorCount}</span>, className: 'text-right' },
                  { key: 'totalDurationMs', header: 'Duration', render: (r) => <span data-numeric>{r.totalDurationMs}ms</span>, className: 'text-right' },
                ]}
                data={traces.data ?? []}
                getRowId={(r) => `${r.runId}:${r.model}`}
              />
            )}
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Latency Breakdown (per model × operation)" />
        <PanelBody>
          {stats.isLoading ? <Spinner /> : (stats.data?.latency.length ?? 0) === 0 ? (
            <EmptyState title="No latency data" description="Run benchmarks to collect timing data." />
          ) : (
            <DataTable
              columns={latencyColumns}
              data={stats.data?.latency ?? []}
              getRowId={(r) => `${r.model}:${r.tool}`}
            />
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
