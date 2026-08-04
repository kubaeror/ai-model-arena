import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useLive } from '../hooks/useLive.js';
import { listRuns } from '../lib/api.js';
import { PageShell } from '../components/ui/PageShell';
import { Panel } from '../components/ui/Panel';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/EmptyState';
import type { ProcStatus } from '../lib/types.js';

function fmtUptime(uptime?: number): string {
  if (!uptime) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - uptime) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function fmtMem(bytes?: number): string {
  if (!bytes) return '—';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}M` : `${Math.floor(bytes / 1024)}K`;
}

function ModelCard({ p }: { p: ProcStatus }) {
  return (
    <Panel className="p-3">
      <div className="flex items-center justify-between">
        <div className="font-display text-14 font-500">{p.model ?? p.name}</div>
        <Badge variant="status" value={p.status} />
      </div>
      <div className="mt-2 font-mono text-12 text-fg-1 flex flex-col gap-1">
        <div>scenario: <span className="text-fg-0">{p.scenario ?? '—'}</span></div>
        <div>cpu: <span className="text-fg-0">{p.cpu ?? 0}%</span> · mem: <span className="text-fg-0">{fmtMem(p.memory)}</span></div>
        <div>uptime: <span className="text-fg-0">{fmtUptime(p.uptime)}</span> · restarts: <span className="text-fg-0">{p.restarts ?? 0}</span></div>
        {p.runId && (
          <div>
            run: <Link className="text-accent hover:underline" to={`/runs/${p.runId}`}>{p.runId}</Link>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function Dashboard() {
  const { processes, connected } = useLive();
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: listRuns, refetchInterval: 5000 });

  return (
    <PageShell
      title="Live Status"
      description={`WebSocket ${connected ? 'connected' : 'disconnected'} · ${processes.length} processes`}
      loading={runsQuery.isLoading}
    >
      <section>
        <h2 className="font-display text-14 font-500 text-fg-1 mb-2">Processes ({processes.length})</h2>
        {processes.length === 0 ? (
          <Panel className="p-6">
            <EmptyState title="No worker processes" description="Launch a run from the Home page." />
          </Panel>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {processes.map((p) => (
              <ModelCard key={p.name} p={p} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="font-display text-14 font-500 text-fg-1 mb-2">Recent runs</h2>
        <Panel className="divide-y divide-border">
          {runsQuery.data && runsQuery.data.length ? (
            runsQuery.data.map((r) => (
              <Link key={r.runId} to={`/runs/${r.runId}`} className="flex items-center justify-between p-3 hover:bg-bg-2">
                <div>
                  <div className="font-display text-14 font-500">{r.scenario} <span className="text-fg-1">· {r.runId}</span></div>
                  <div className="font-body text-12 text-fg-1">{r.models.join(', ')} · {new Date(r.startedAt).toLocaleString()}</div>
                </div>
                <Badge variant="status" value={r.status} />
              </Link>
            ))
          ) : (
            <div className="p-6 text-center">
              <EmptyState title="No runs yet" />
            </div>
          )}
        </Panel>
      </section>
    </PageShell>
  );
}
