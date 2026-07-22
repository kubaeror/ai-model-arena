import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { StatTile } from '../components/ui/StatTile';
import { MetricBar } from '../components/ui/MetricBar';
import { Button } from '../components/ui/Button';
import { Sankey, type SankeyNode, type SankeyLink } from '../components/ui/Sankey';
import { EmptyState } from '../components/ui/EmptyState';
import { Launcher } from '../components/Launcher';
import { useTpsLeaderboard } from '../hooks/useMetrics';
import { useRuntimeMetrics } from '../hooks/useMetrics';
import { useCacheStats } from '../hooks/useCache';
import { getExportCsvUrl } from '../lib/api';

export function Home() {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const { data: tpsData } = useTpsLeaderboard();
  const { data: runtime } = useRuntimeMetrics({ limit: 20 });
  const { data: cacheStats } = useCacheStats();

  const activeRuns = runtime?.filter(r => r.success === 0 && r.run_id).length ?? 0;
  const modelCount = tpsData?.length ?? 0;
  const cacheSources = cacheStats?.length ?? 0;

  // Sankey: aggregate tokens from recent runtime stats
  const recentRuntime = runtime ?? [];
  const totalCacheRead = recentRuntime.reduce((sum, r) => sum + Math.round((r.cache_hit_rate ?? 0) * 1000), 0);
  const totalCompletion = recentRuntime.reduce((sum, r) => sum + Math.round((r.tps ?? 0) * 10), 0);
  const totalCost = recentRuntime.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  const sankeyNodes: SankeyNode[] = [
    { name: 'prompt' },
    { name: 'cache_read', color: 'var(--accent)' },
    { name: 'completion', color: 'var(--warn)' },
    { name: 'cost', color: 'var(--danger)' },
  ];
  const sankeyLinks: SankeyLink[] = [
    { source: 'prompt', target: 'cache_read', value: Math.max(1, totalCacheRead) },
    { source: 'prompt', target: 'completion', value: Math.max(1, totalCompletion) },
    { source: 'cache_read', target: 'cost', value: Math.max(1, Math.round(totalCost * 1000)) },
    { source: 'completion', target: 'cost', value: Math.max(1, Math.round(totalCost * 1000)) },
  ];

  const topTps = (tpsData ?? []).slice(0, 3);
  const recentRuns = (runtime ?? []).slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-44 font-700">Mission Control</h1>
        <div className="flex gap-2">
          <a href={getExportCsvUrl()} download="arena-export.csv" className="no-underline">
            <Button variant="ghost" size="sm">Export CSV</Button>
          </a>
          <Button onClick={() => setLauncherOpen(true)}>+ Run</Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatTile value={activeRuns} label="Active runs" />
        <StatTile value={modelCount} label="Models in DB" />
        <StatTile value={cacheSources} label="Cache sources" />
      </div>

      <Panel>
        <PanelHeader title="Token Flow" actions={<span className="font-mono text-12 text-fg-1">live</span>} />
        <PanelBody>
          {recentRuntime.length === 0 ? (
            <EmptyState title="No runs yet" description="Launch a run to see token flow." />
          ) : (
            <Sankey nodes={sankeyNodes} links={sankeyLinks} />
          )}
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel>
          <PanelHeader title="Top TPS" />
          <PanelBody>
            {topTps.length === 0 ? (
              <EmptyState title="No TPS data" />
            ) : (
              <div className="flex flex-col gap-3">
                {topTps.map(m => (
                  <MetricBar
                    key={m.model_id}
                    label={m.name}
                    value={m.avg_tps ?? 0}
                    min={0}
                    max={Math.max(...topTps.map(t => t.avg_tps ?? 0), 1)}
                  />
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Recent Runs" />
          <PanelBody>
            {recentRuns.length === 0 ? (
              <EmptyState title="No recent runs" />
            ) : (
              <div className="flex flex-col">
                {recentRuns.map(r => (
                  <Link
                    key={r.run_id}
                    to={`/runs/${r.run_id}`}
                    className="flex items-center justify-between border-b border-border/50 py-2 hover:bg-bg-2 px-2 rounded-inner"
                  >
                    <span className="font-mono text-14">{r.run_id}</span>
                    <span className={r.success ? 'text-accent font-mono text-14' : 'text-danger font-mono text-14'}>
                      {r.success ? '✓' : '✗'}
                    </span>
                    <span className="font-mono text-14 text-fg-1" data-numeric>{r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-'}</span>
                  </Link>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>

      <Launcher open={launcherOpen} onClose={() => setLauncherOpen(false)} />
    </div>
  );
}
