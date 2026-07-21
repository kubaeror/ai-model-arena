import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLive } from '../hooks/useLive.js';
import { listRuns } from '../lib/api.js';
import { Card, Badge, Spinner } from '../components/ui.js';
import type { ProcStatus } from '../lib/types.js';

function statusColor(status: string): 'green' | 'red' | 'yellow' | 'slate' {
  if (status === 'online' || status === 'launching') return 'green';
  if (status === 'errored') return 'red';
  if (status === 'stopped') return 'slate';
  return 'yellow';
}

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
    <Card className="p-1">
      <div className="flex items-center justify-between">
        <div className="font-medium">{p.model ?? p.name}</div>
        <Badge color={statusColor(p.status)}>{p.status}</Badge>
      </div>
      <div className="mt-2 text-xs text-muted space-y-0.5">
        <div>scenario: <span className="text-foreground">{p.scenario ?? '—'}</span></div>
        <div>cpu: <span className="text-foreground">{p.cpu ?? 0}%</span> · mem: <span className="text-foreground">{fmtMem(p.memory)}</span></div>
        <div>uptime: <span className="text-foreground">{fmtUptime(p.uptime)}</span> · restarts: <span className="text-foreground">{p.restarts ?? 0}</span></div>
        {p.runId && (
          <div>
            run: <Link className="text-primary hover:underline" to={`/runs/${p.runId}`}>{p.runId}</Link>
          </div>
        )}
      </div>
    </Card>
  );
}

export function Dashboard() {
  const { processes, connected } = useLive();
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: listRuns, refetchInterval: 5000 });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Live Status</h1>
        <Badge color={connected ? 'green' : 'red'}>{connected ? 'WS connected' : 'WS disconnected'}</Badge>
      </div>

      <section>
        <h2 className="text-sm font-medium text-muted mb-2">Processes ({processes.length})</h2>
        {processes.length === 0 ? (
          <Card className="p-6 text-center text-muted text-sm">No worker processes. Launch a run from the “Run” page.</Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {processes.map((p) => (
              <ModelCard key={p.name} p={p} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted mb-2">Recent runs</h2>
        <Card className="divide-y divide-border">
          {runsQuery.isLoading ? (
            <div className="p-1 flex items-center gap-2 text-muted text-sm"><Spinner /> Loading runs…</div>
          ) : runsQuery.data && runsQuery.data.length ? (
            runsQuery.data.map((r) => (
              <Link key={r.runId} to={`/runs/${r.runId}`} className="flex items-center justify-between p-3 hover:bg-muted/10">
                <div>
                  <div className="font-medium text-sm">{r.scenario} <span className="text-muted">· {r.runId}</span></div>
                  <div className="text-xs text-muted">{r.models.join(', ')} · {new Date(r.startedAt).toLocaleString()}</div>
                </div>
                <Badge color={r.status === 'completed' ? 'slate' : r.status === 'running' ? 'green' : r.status === 'errored' ? 'red' : 'yellow'}>{r.status}</Badge>
              </Link>
            ))
          ) : (
            <div className="p-1 text-muted text-sm">No runs yet.</div>
          )}
        </Card>
      </section>
    </div>
  );
}
