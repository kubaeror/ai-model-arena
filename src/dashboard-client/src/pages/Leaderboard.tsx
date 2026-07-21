import { useState } from 'react';
import { Panel } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';
import { useCacheLeaderboard, type LeaderboardEntry } from '../hooks/useCache';
import { Button } from '../components/ui/Button';

const COLUMNS: Column<LeaderboardEntry>[] = [
  { key: 'name', header: 'Model', sortable: true, render: m => <span className="font-mono text-14 text-fg-0">{m.name}</span> },
  { key: 'provider_id', header: 'Provider', sortable: true, render: m => <Badge variant="provider" value={m.provider_id} /> },
  { key: 'context_limit', header: 'Context', sortable: true, render: m => <span data-numeric>{m.context_limit?.toLocaleString() ?? '-'}</span> },
  { key: 'input', header: 'In $/M', sortable: true, render: m => <span data-numeric>{m.input != null ? `$${m.input}` : '-'}</span> },
  { key: 'output', header: 'Out $/M', sortable: true, render: m => <span data-numeric>{m.output != null ? `$${m.output}` : '-'}</span> },
  { key: 'intelligence', header: 'Intelligence', sortable: true, render: m => <span data-numeric className="text-accent">{m.intelligence != null ? m.intelligence.toFixed(1) : '-'}</span> },
  { key: 'coding', header: 'Coding', sortable: true, render: m => <span data-numeric>{m.coding != null ? m.coding.toFixed(1) : '-'}</span> },
  { key: 'arena_tps', header: 'Arena TPS', sortable: true, render: m => <span data-numeric>{m.arena_tps != null ? m.arena_tps.toFixed(1) : '-'}</span> },
  { key: 'arena_latency', header: 'Arena p50', sortable: true, render: m => <span data-numeric>{m.arena_latency != null ? `${Math.round(m.arena_latency)}ms` : '-'}</span> },
  { key: 'arena_runs', header: 'Runs', sortable: true, render: m => <span data-numeric>{m.arena_runs}</span> },
];

export function Leaderboard() {
  const { data, isLoading, error, refetch } = useCacheLeaderboard();
  const [onlyWithArena, setOnlyWithArena] = useState(false);

  const filtered = (data ?? []).filter(m => !onlyWithArena || m.arena_runs > 0);

  function exportCsv() {
    if (!filtered.length) return;
    const headers = COLUMNS.map(c => c.header).join(',');
    const rows = filtered.map(m => COLUMNS.map(c => String((m as unknown as Record<string, unknown>)[c.key] ?? '')).join(','));
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leaderboard.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-16">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-28 font-600">Leaderboard</h1>
        <div className="flex gap-8">
          <Button variant="ghost" size="sm" onClick={() => setOnlyWithArena(v => !v)}>
            {onlyWithArena ? '✓ ' : ''}Arena data only
          </Button>
          <Button variant="ghost" size="sm" onClick={exportCsv}>Export CSV</Button>
        </div>
      </div>
      <Panel>
        {isLoading ? <div className="flex justify-center py-48"><Spinner /></div>
        : error ? <ErrorState message="Failed to load leaderboard" onRetry={() => refetch()} />
        : filtered.length === 0 ? <EmptyState title="No models" />
        : <DataTable columns={COLUMNS} data={filtered} getRowId={m => m.id} />}
        <div className="pt-8 text-right font-mono text-12 text-fg-1">{filtered.length} models</div>
      </Panel>
    </div>
  );
}
