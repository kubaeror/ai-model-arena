import { useQuery } from '@tanstack/react-query';
import { getCostLeaderboard } from '../lib/api.js';
import type { CostLeaderboardEntry } from '../lib/api.js';
import { PageShell } from '../components/ui/PageShell';
import { Panel } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { ErrorState } from '../components/ui/ErrorState';
import { EmptyState } from '../components/ui/EmptyState';

const COLUMNS: Column<CostLeaderboardEntry>[] = [
  { key: 'model', header: 'Model', sortable: true, render: m => <span className="font-mono text-14">{m.model}</span> },
  { key: 'runs', header: 'Runs', sortable: true, render: m => <span data-numeric>{m.runs}</span>, className: 'text-right' },
  { key: 'successes', header: 'Successes', sortable: true, render: m => <span data-numeric>{m.successes}</span>, className: 'text-right' },
  { key: 'successRate', header: 'Success Rate', sortable: true, render: m => <span data-numeric>{(m.successRate * 100).toFixed(1)}%</span>, className: 'text-right' },
  { key: 'totalCost', header: 'Total Cost', sortable: true, render: m => <span data-numeric>${m.totalCost.toFixed(4)}</span>, className: 'text-right' },
  { key: 'costPerSuccess', header: 'Cost/Success', sortable: true, render: m => <span data-numeric className="font-600">{m.successes > 0 ? `$${m.costPerSuccess.toFixed(4)}` : '-'}</span>, className: 'text-right' },
  { key: 'avgCostPerRun', header: 'Avg Cost/Run', sortable: true, render: m => <span data-numeric>${m.avgCostPerRun.toFixed(4)}</span>, className: 'text-right' },
  { key: 'totalTokens', header: 'Total Tokens', sortable: true, render: m => <span data-numeric>{m.totalTokens.toLocaleString()}</span>, className: 'text-right' },
];

export function CostLeaderboard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cost-leaderboard'],
    queryFn: getCostLeaderboard,
    refetchInterval: 30_000,
  });

  return (
    <PageShell
      title="Cost Leaderboard"
      description="Models ranked by cost per successful task. Lower is better."
      loading={isLoading}
    >
      <Panel>
        {error ? <ErrorState message="Failed to load cost data" onRetry={() => refetch()} />
        : !data || data.length === 0 ? <EmptyState title="No cost data" />
        : <DataTable columns={COLUMNS} data={data} getRowId={m => m.model} />}
        <div className="pt-2 text-right font-mono text-12 text-fg-1">{(data ?? []).length} models</div>
      </Panel>
    </PageShell>
  );
}
