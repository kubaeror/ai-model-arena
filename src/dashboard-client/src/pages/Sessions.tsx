import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Button } from '../components/ui/Button';
import { listSessions, type SessionRow } from '../lib/api';

const STATUS_TIER: Record<string, 'status' | 'success' | 'failure' | 'neutral'> = {
  active: 'status',
  completed: 'success',
  errored: 'failure',
};

const columns: Column<SessionRow>[] = [
  { key: 'id', header: 'Session', render: (r) => <span className="font-mono text-12">{r.id.slice(0, 24)}…</span> },
  { key: 'model', header: 'Model' },
  {
    key: 'status', header: 'Status',
    render: (r) => <Badge variant={STATUS_TIER[r.status] ?? 'neutral'} value={r.status} />,
  },
  { key: 'message_count', header: 'Messages', sortable: true, className: 'text-right', render: (r) => <span data-numeric>{r.message_count}</span> },
  { key: 'call_count', header: 'LLM calls', sortable: true, className: 'text-right', render: (r) => <span data-numeric>{r.call_count}</span> },
  {
    key: 'created_at', header: 'Created', sortable: true,
    render: (r) => <span className="font-mono text-12">{new Date(r.created_at).toLocaleString()}</span>,
  },
];

const PAGE = 50;

export function Sessions() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sessions', status, offset],
    queryFn: () => listSessions({ limit: PAGE, offset, ...(status ? { status } : {}) }),
    refetchInterval: 15_000,
  });

  return (
    <PageShell title="Sessions" description="Checkpointed agent sessions — one per run + model">
      <Panel>
        <PanelHeader
          title="Session Log"
          actions={
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
              className="rounded-inner border border-border bg-bg-1 px-2 py-1 font-mono text-12"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="active">active</option>
              <option value="completed">completed</option>
              <option value="errored">errored</option>
            </select>
          }
        />
        <PanelBody>
          {isLoading ? (
            <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading sessions…</div>
          ) : isError ? (
            <ErrorState message="Failed to load sessions" onRetry={() => void refetch()} />
          ) : (data?.sessions.length ?? 0) === 0 ? (
            <EmptyState title="No sessions yet" description="Sessions appear once the runner checkpoints a run." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={data?.sessions ?? []}
                getRowId={(r) => r.id}
                onRowClick={(r) => navigate(`/sessions/${r.id}`)}
              />
              {(data?.sessions.length ?? 0) < (data?.total ?? 0) && (
                <div className="flex justify-center p-3">
                  <Button variant="ghost" size="sm" onClick={() => setOffset((o) => o + PAGE)}>Load more</Button>
                </div>
              )}
            </>
          )}
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
