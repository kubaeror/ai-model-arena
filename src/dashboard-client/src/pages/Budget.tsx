import { useQuery } from '@tanstack/react-query';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { StatTile } from '../components/ui/StatTile';
import { DataTable } from '../components/ui/DataTable';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { getBudget } from '../lib/api';
import type { Column } from '../components/ui/DataTable';

interface ModelRow {
  model: string;
  dailySpent: number;
  dailyLimit: number | null;
  monthlySpent: number;
  monthlyLimit: number | null;
}

function fmtLimit(limit: number | null): string {
  return limit != null ? `$${limit.toFixed(2)}` : 'unlimited';
}

function pct(spent: number, limit: number | null): string {
  if (!limit) return '';
  const p = Math.min((spent / limit) * 100, 100);
  return `${p.toFixed(0)}%`;
}

export function Budget() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['budget'],
    queryFn: getBudget,
    refetchInterval: 60_000,
  });

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (error) return <div className="text-red-500 py-4">Error loading budget: {(error as Error).message}</div>;
  if (!data) return <EmptyState title="No budget data" />;

  const dailyPct = pct(data.global.daily.spent, data.global.daily.limit);
  const monthlyPct = pct(data.global.monthly.spent, data.global.monthly.limit);

  const columns: Column<ModelRow>[] = [
    { key: 'model', header: 'Model', sortable: true },
    { key: 'dailySpent', header: 'Daily Spent', sortable: true, render: r => `$${r.dailySpent.toFixed(4)}` },
    { key: 'dailyLimit', header: 'Daily Limit', sortable: true, render: r => fmtLimit(r.dailyLimit) },
    { key: 'monthlySpent', header: 'Monthly Spent', sortable: true, render: r => `$${r.monthlySpent.toFixed(4)}` },
    { key: 'monthlyLimit', header: 'Monthly Limit', sortable: true, render: r => fmtLimit(r.monthlyLimit) },
  ];

  const rows: ModelRow[] = Object.entries(data.models).map(([model, s]) => ({
    model,
    dailySpent: s.daily.spent,
    dailyLimit: s.daily.limit,
    monthlySpent: s.monthly.spent,
    monthlyLimit: s.monthly.limit,
  })).sort((a, b) => b.monthlySpent - a.monthlySpent);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-44 font-700">Budget</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatTile
          value={isLoading ? <Spinner /> : `$${data.global.daily.spent.toFixed(2)}`}
          label="Daily Spend"
        />
        <StatTile
          value={isLoading ? <Spinner /> : fmtLimit(data.global.daily.limit)}
          label="Daily Limit"
        />
        <StatTile
          value={isLoading ? <Spinner /> : `$${data.global.monthly.spent.toFixed(2)}`}
          label="Monthly Spend"
        />
        <StatTile
          value={isLoading ? <Spinner /> : fmtLimit(data.global.monthly.limit)}
          label="Monthly Limit"
        />
      </div>

      {(dailyPct || monthlyPct) ? (
        <Panel>
          <PanelHeader title="Usage" />
          <PanelBody>
            <div className="flex flex-col gap-3">
              {data.global.daily.limit ? (
                <div>
                  <div className="flex justify-between text-12 text-fg-1 mb-1">
                    <span>Daily</span>
                    <span>{pct(data.global.daily.spent, data.global.daily.limit)}</span>
                  </div>
                  <div className="h-2 rounded bg-bg-2 overflow-hidden">
                    <div className="h-full rounded bg-accent" style={{ width: `${Math.min((data.global.daily.spent / data.global.daily.limit) * 100, 100)}%` }} />
                  </div>
                </div>
              ) : null}
              {data.global.monthly.limit ? (
                <div>
                  <div className="flex justify-between text-12 text-fg-1 mb-1">
                    <span>Monthly</span>
                    <span>{pct(data.global.monthly.spent, data.global.monthly.limit)}</span>
                  </div>
                  <div className="h-2 rounded bg-bg-2 overflow-hidden">
                    <div className="h-full rounded bg-accent" style={{ width: `${Math.min((data.global.monthly.spent / data.global.monthly.limit) * 100, 100)}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Per-Model Breakdown" />
        <PanelBody>
          {rows.length === 0 ? <EmptyState title="No model budget data" /> : (
            <DataTable columns={columns} data={rows} />
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
