import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { PageShell } from '../components/ui/PageShell';
import { Panel, PanelHeader, PanelBody } from '../components/ui/Panel';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Spinner } from '../components/ui/Spinner';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Button } from '../components/ui/Button';
import { listFiles, type FileRow } from '../lib/api';

const columns: Column<FileRow>[] = [
  { key: 'path', header: 'Path', render: (r) => <span className="font-mono text-12">{r.path}</span> },
  { key: 'model', header: 'Model' },
  {
    key: 'run_id', header: 'Run',
    render: (r) => <span className="font-mono text-12">{r.run_id}</span>,
  },
  {
    key: 'produced_by_tool', header: 'Produced by',
    render: (r) => r.produced_by_tool ? <span className="font-mono text-12 text-accent">{r.produced_by_tool}</span> : <span className="text-fg-1">—</span>,
  },
  {
    key: 'produced_at', header: 'Produced', sortable: true,
    render: (r) => <span className="font-mono text-12">{new Date(r.produced_at).toLocaleString()}</span>,
  },
];

const PAGE = 50;

export function Files() {
  const navigate = useNavigate();
  const [model, setModel] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['files', model, offset],
    queryFn: () => listFiles({ limit: PAGE, offset, ...(model ? { model } : {}) }),
    refetchInterval: 15_000,
  });

  return (
    <PageShell title="Files" description="Artifacts produced by runs — from the artifact manifests">
      <Panel>
        <PanelHeader
          title="Produced files"
          actions={
            <input
              value={model}
              onChange={(e) => { setModel(e.target.value.trim()); setOffset(0); }}
              placeholder="Filter by model…"
              className="rounded-inner border border-border bg-bg-1 px-2 py-1 font-mono text-12"
              aria-label="Filter by model"
            />
          }
        />
        <PanelBody>
          {isLoading ? (
            <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading files…</div>
          ) : isError ? (
            <ErrorState message="Failed to load files" onRetry={() => void refetch()} />
          ) : (data?.files.length ?? 0) === 0 ? (
            <EmptyState title="No files yet" description="Files appear after a run completes and its manifest is recorded." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={data?.files ?? []}
                getRowId={(r) => String(r.id)}
                onRowClick={(r) => navigate(`/runs/${encodeURIComponent(r.run_id)}`)}
              />
              {(data?.files.length ?? 0) < (data?.total ?? 0) && (
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
