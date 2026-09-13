import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
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
  const {
    data, isLoading, isError, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['sessions', status],
    queryFn: ({ pageParam }) => listSessions({ limit: PAGE, offset: pageParam, ...(status ? { status } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      const loaded = allPages.reduce((n, p) => n + p.sessions.length, 0);
      return loaded < lastPage.total ? lastPageParam + PAGE : undefined;
    },
    refetchInterval: 15_000,
  });
  const sessions = data?.pages.flatMap((p) => p.sessions) ?? [];

  return (
    <PageShell title="Sessions" description="Checkpointed agent sessions — one per run + model">
      <Panel>
        <PanelHeader
          title="Session Log"
          actions={
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
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
          ) : sessions.length === 0 ? (
            <EmptyState title="No sessions yet" description="Sessions appear once the runner checkpoints a run." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={sessions}
                getRowId={(r) => r.id}
                onRowClick={(r) => navigate(`/sessions/${r.id}`)}
              />
              {hasNextPage && (
                <div className="flex justify-center p-3">
                  <Button variant="ghost" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          )}
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
