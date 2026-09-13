import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Button } from '../components/ui/Button';
import { listAudit, type AuditEntry } from '../lib/api';

function summarize(v: unknown, max = 200): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

const columns: Column<AuditEntry>[] = [
  { key: 'at', header: 'When', sortable: true, render: (r) => <span className="font-mono text-12">{new Date(r.at).toLocaleString()}</span> },
  { key: 'actor', header: 'Actor' },
  { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-12 text-accent">{r.action}</span> },
  { key: 'entity_type', header: 'Entity' },
  { key: 'entity_id', header: 'Entity ID', render: (r) => <span className="font-mono text-12">{r.entity_id ?? '—'}</span> },
  { key: 'after', header: 'After', render: (r) => <span className="font-mono text-12 text-fg-1 whitespace-pre-wrap">{summarize(r.after)}</span> },
  { key: 'before', header: 'Before', render: (r) => <span className="font-mono text-12 text-fg-1 whitespace-pre-wrap">{summarize(r.before)}</span> },
];

const PAGE = 50;

/** Keep the first occurrence of each row id so overlapping offset pages never render duplicates. */
function dedupeById(rows: AuditEntry[]): AuditEntry[] {
  const seen = new Set<number>();
  const out: AuditEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export function Audit() {
  const [actor, setActor] = useState<string>('');
  const [action, setAction] = useState<string>('');
  const {
    data, isLoading, isError, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['audit', actor, action],
    queryFn: ({ pageParam }) => listAudit({
      actor: actor || undefined,
      action: action || undefined,
      limit: PAGE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.entries.length === 0) return undefined;
      const loaded = dedupeById(allPages.flatMap((p) => p.entries)).length;
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 15_000,
  });
  const entries = dedupeById(data?.pages.flatMap((p) => p.entries) ?? []);

  return (
    <PageShell title="Audit Log" description="Admin-only — every sensitive action, who did it, and what changed">
      <Panel>
        <PanelHeader
          title="Audit trail"
          actions={
            <div className="flex gap-2">
              <input
                value={actor}
                onChange={(e) => setActor(e.target.value.trim())}
                placeholder="Filter by actor…"
                className="rounded-inner border border-border bg-bg-1 px-2 py-1 font-mono text-12"
                aria-label="Filter by actor"
              />
              <input
                value={action}
                onChange={(e) => setAction(e.target.value.trim())}
                placeholder="Filter by action…"
                className="rounded-inner border border-border bg-bg-1 px-2 py-1 font-mono text-12"
                aria-label="Filter by action"
              />
            </div>
          }
        />
        <PanelBody>
          {isLoading ? (
            <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading audit log…</div>
          ) : isError ? (
            <ErrorState message="Failed to load audit log" onRetry={() => void refetch()} />
          ) : entries.length === 0 ? (
            <EmptyState title="No audit entries" description="Audit entries appear as users take sensitive actions." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={entries}
                getRowId={(r) => String(r.id)}
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
