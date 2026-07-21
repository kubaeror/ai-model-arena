import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { Tabs } from '../components/ui/Tabs';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { LineChart } from '../components/ui/LineChart';
import { StackedBar } from '../components/ui/StackedBar';
import { useCatalogModel, type BenchmarkRow } from '../hooks/useCatalog';

export function ModelDetail() {
  const { id = '' } = useParams();
  const decodedId = decodeURIComponent(id);
  const { data, isLoading, error, refetch } = useCatalogModel(decodedId);
  const [tab, setTab] = useState('overview');

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (error) return <ErrorState message="Failed to load model" onRetry={() => refetch()} />;
  if (!data) return <EmptyState title="Model not found" />;

  const { model, benchmarks, runtime } = data;

  const benchmarkGroups = benchmarks.reduce<Record<string, BenchmarkRow[]>>((acc, b) => {
    (acc[b.benchmark] ??= []).push(b);
    return acc;
  }, {});

  const runtimeLabels = runtime.map(r => new Date(r.measured_at).toLocaleDateString());
  const latencySeries = [
    { name: 'p50', data: runtime.map(r => r.latency_p50_ms ?? 0) },
    { name: 'p95', data: runtime.map(r => r.latency_p95_ms ?? 0) },
  ];
  const tpsSeries = [{ name: 'TPS', data: runtime.map(r => r.tps ?? 0) }];
  const tokenSeries = [
    { name: 'cache_read', data: runtime.map(r => Math.round((r.cache_hit_rate ?? 0) * 1000)) },
    { name: 'cost', data: runtime.map(r => Math.round((r.cost_usd ?? 0) * 1000)) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="font-display text-44 font-700">{model.name}</h1>
        <Badge variant="provider" value={model.provider_id} />
        {model.status && <Badge variant="status" value={model.status} />}
        {model.reasoning && <Badge variant="reasoning" value="reason" />}
        {model.family && <span className="font-mono text-14 text-fg-1">{model.family}</span>}
      </header>

      <div className="grid grid-cols-4 gap-3">
        <Panel className="p-3"><div className="font-body text-12 text-fg-1 uppercase">Context</div><div className="font-display text-20 font-600" data-numeric>{model.context_limit?.toLocaleString() ?? '-'}</div></Panel>
        <Panel className="p-3"><div className="font-body text-12 text-fg-1 uppercase">Output</div><div className="font-display text-20 font-600" data-numeric>{model.output_limit?.toLocaleString() ?? '-'}</div></Panel>
        <Panel className="p-3"><div className="font-body text-12 text-fg-1 uppercase">Input $/M</div><div className="font-display text-20 font-600" data-numeric>{model.input != null ? `$${model.input}` : '-'}</div></Panel>
        <Panel className="p-3"><div className="font-body text-12 text-fg-1 uppercase">Output $/M</div><div className="font-display text-20 font-600" data-numeric>{model.output != null ? `$${model.output}` : '-'}</div></Panel>
      </div>

      <Tabs
        items={[
          { id: 'overview', label: 'Overview' },
          { id: 'benchmarks', label: 'Benchmarks' },
          { id: 'metrics', label: 'Arena metrics' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <Panel>
          <PanelHeader title="Capabilities" />
          <PanelBody>
            <div className="grid grid-cols-2 gap-2 font-mono text-14">
              <div>Attachment: <span className="text-accent">{model.attachment ? 'yes' : 'no'}</span></div>
              <div>Temperature: <span className="text-accent">{model.temperature ? 'yes' : 'no'}</span></div>
              <div>Tool calls: <span className="text-accent">{model.tool_call ? 'yes' : 'no'}</span></div>
              <div>Reasoning: <span className="text-accent">{model.reasoning ? 'yes' : 'no'}</span></div>
            </div>
            {model.reasoning_options && (
              <div className="mt-4">
                <div className="font-body text-12 text-fg-1 uppercase mb-2">Reasoning options</div>
                <pre className="font-mono text-12 text-fg-1 bg-bg-0 p-3 rounded-inner overflow-x-auto">{model.reasoning_options}</pre>
              </div>
            )}
          </PanelBody>
        </Panel>
      )}

      {tab === 'benchmarks' && (
        <div className="flex flex-col gap-4">
          {Object.keys(benchmarkGroups).length === 0 ? (
            <EmptyState title="No benchmarks" description="This model has no benchmark data yet." />
          ) : (
            Object.entries(benchmarkGroups).map(([name, rows]) => (
              <Panel key={name}>
                <PanelHeader title={name} />
                <PanelBody>
                  <div className="flex flex-col gap-1">
                    {rows.map(r => (
                      <div key={r.source} className="flex items-center justify-between border-b border-border/50 py-2 last:border-0">
                        <span className="font-mono text-14">{r.source}{r.is_preferred ? ' ★' : ''}</span>
                        <span className="font-display text-20 font-600 text-accent" data-numeric>{r.score.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </PanelBody>
              </Panel>
            ))
          )}
        </div>
      )}

      {tab === 'metrics' && (
        <div className="flex flex-col gap-4">
          {runtime.length === 0 ? (
            <EmptyState title="No arena runs yet" description="Trigger a run from Home to see live metrics." />
          ) : (
            <>
              <Panel>
                <PanelHeader title="Latency over time" />
                <PanelBody><LineChart series={latencySeries} xLabels={runtimeLabels} yLabel="ms" /></PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="TPS over time" />
                <PanelBody><LineChart series={tpsSeries} xLabels={runtimeLabels} yLabel="tokens/s" /></PanelBody>
              </Panel>
              <Panel>
                <PanelHeader title="Cache + cost breakdown" />
                <PanelBody><StackedBar series={tokenSeries} xLabels={runtimeLabels} /></PanelBody>
              </Panel>
            </>
          )}
        </div>
      )}
    </div>
  );
}
